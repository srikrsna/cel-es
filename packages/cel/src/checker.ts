// Copyright 2024-2026 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type {
  ExprSchema,
  Constant,
  Expr,
  SourceInfo,
  Expr_Ident,
  Expr_CreateList,
  Expr_Call,
  ConstantSchema,
} from "@bufbuild/cel-spec/cel/expr/syntax_pb.js";
import {
  type CheckedExpr,
  CheckedExprSchema,
  type ReferenceSchema,
  type Type,
  type TypeSchema,
  Type_PrimitiveType,
} from "@bufbuild/cel-spec/cel/expr/checked_pb.js";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  CelScalar,
  celType,
  type CelType,
  type CelValue,
  DURATION,
  listType,
  type mapKeyType,
  mapType,
  objectType,
  TIMESTAMP,
} from "./type.js";
import { equalsType } from "./equals.js";
import { NullValue } from "@bufbuild/protobuf/wkt";
import type { CelEnv } from "./env.js";
import type { FuncGroup } from "./resolver.js";
import type { CelFunc } from "./func.js";
import { resolveCandidateNames } from "./namespace.js";
import { celError } from "./error.js";
import { isCelUint } from "./uint.js";
import { createScope } from "./scope.js";

const noopScope = createScope();

export class Checker {
  private readonly referenceMap: Map<
    bigint,
    MessageInitShape<typeof ReferenceSchema>
  > = new Map();
  private readonly typeMap: Map<bigint, CelType> = new Map();
  private scope = noopScope;

  constructor(private readonly env: CelEnv) {}

  check(expr: Expr, sourceInfo: SourceInfo | undefined): CheckedExpr {
    // Clear each time we check since Checker instances are cached per environment.
    this.typeMap.clear();
    this.scope = noopScope;
    this.referenceMap.clear();
    return create(CheckedExprSchema, {
      expr: this.checkExpr(expr),
      sourceInfo,
      referenceMap: celReferenceMapToProtoReferenceMap(this.referenceMap),
      typeMap: celTypeMapToProtoTypeMap(this.typeMap),
    });
  }

  private checkExpr(expr: Expr): MessageInitShape<typeof ExprSchema> {
    switch (expr.exprKind.case) {
      case "constExpr":
        return this.checkConstExpr(expr.id, expr.exprKind.value);
      case "identExpr":
        return this.checkIdentExpr(expr.id, expr.exprKind.value);
      case "listExpr":
        return this.checkListExpr(expr.id, expr.exprKind.value);
      case "callExpr":
        return this.checkCallExpr(expr.id, expr.exprKind.value);
      default:
        throw new Error(`Unsupported expression kind: ${expr.exprKind.case}`);
    }
  }

  private checkConstExpr(
    id: bigint,
    constant: Constant,
  ): MessageInitShape<typeof ExprSchema> {
    switch (constant.constantKind.case) {
      case "boolValue":
        this.setType(id, CelScalar.BOOL);
        break;
      case "bytesValue":
        this.setType(id, CelScalar.BYTES);
        break;
      case "doubleValue":
        this.setType(id, CelScalar.DOUBLE);
        break;
      case "durationValue":
        this.setType(id, DURATION);
        break;
      case "int64Value":
        this.setType(id, CelScalar.INT);
        break;
      case "nullValue":
        this.setType(id, CelScalar.NULL);
        break;
      case "stringValue":
        this.setType(id, CelScalar.STRING);
        break;
      case "timestampValue":
        this.setType(id, TIMESTAMP);
        break;
      case "uint64Value":
        this.setType(id, CelScalar.UINT);
        break;
      default:
        throw new Error(
          `unexpected constant kind: ${constant.constantKind.case}`,
        );
    }
    return {
      id,
      exprKind: {
        case: "constExpr",
        value: constant,
      },
    };
  }

  private checkIdentExpr(
    id: bigint,
    ident: Expr_Ident,
  ): MessageInitShape<typeof ExprSchema> {
    const variable = this.resolveVariable(ident.name);
    if (variable === undefined) {
      throw celError(
        `undeclared reference to '${ident.name}' (in container '${this.env.namespace}')`,
        id,
      );
    }
    this.setType(id, variable.type);
    this.setReference(id, identReference(variable.name));
    return {
      id,
      exprKind: {
        case: "identExpr",
        value: {
          name: variable.name,
        },
      },
    };
  }

  private checkListExpr(
    id: bigint,
    listExpr: Expr_CreateList,
  ): MessageInitShape<typeof ExprSchema> {
    const elements: MessageInitShape<typeof ExprSchema>[] = [];
    let listElemType: CelType | undefined = undefined;
    for (const elem of listExpr.elements) {
      elements.push(this.checkExpr(elem));
      const elemType = this.typeMap.get(elem.id);
      if (!elemType) {
        throw celError(`element has no type`, elem.id);
      }
      if (listElemType === undefined) {
        listElemType = elemType;
      } else if (!equalsType(listElemType, elemType)) {
        listElemType = CelScalar.DYN;
      }
    }
    this.setType(id, listType(listElemType ?? CelScalar.DYN));
    return {
      id,
      exprKind: {
        case: "listExpr",
        value: {
          elements,
          optionalIndices: listExpr.optionalIndices,
        },
      },
    };
  }

  private checkCallExpr(
    id: bigint,
    call: Expr_Call,
  ): MessageInitShape<typeof ExprSchema> {
    const fnName = call.function;
    let target: MessageInitShape<typeof ExprSchema> | undefined = undefined;
    let targetType: CelType | undefined = undefined;
    if (call.target) {
      target = this.checkExpr(call.target);
      targetType = this.typeMap.get(call.target.id);
      if (!targetType) {
        throw celError(`target has no type`, call.target.id);
      }
    }
    const args: MessageInitShape<typeof ExprSchema>[] = [];
    const argTypes: CelType[] = [];
    for (const arg of call.args) {
      args.push(this.checkExpr(arg));
      const argType = this.typeMap.get(arg.id);
      if (!argType) {
        throw celError(`argument has no type`, arg.id);
      }
      argTypes.push(argType);
    }
    const fnGroup = this.env.funcs.find(fnName);
    if (!fnGroup) {
      throw celError(
        `undeclared reference to '${fnName}' (in container '${this.env.namespace}')`,
        id,
      );
    }
    const { resultType, overloadIds } = this.resolveOverload(
      id,
      fnName,
      fnGroup,
      targetType,
      argTypes,
    );
    this.setType(id, resultType);
    this.setReference(id, functionReference(fnName, overloadIds));
    return {
      id,
      exprKind: {
        case: "callExpr",
        value: {
          target,
          function: fnName,
          args,
        },
      },
    };
  }

  private resolveOverload(
    id: bigint,
    fnName: string,
    fnGroup: FuncGroup,
    targetType: CelType | undefined,
    argTypes: CelType[],
  ): { resultType: CelType; overloadIds: string[] } {
    const funcs = Array.from(fnGroup);
    const matchingOverloads: { resultType: CelType; overloadId: string }[] = [];
    for (const fn of funcs) {
      const isMethod = fn.target !== undefined;
      const hasTarget = targetType !== undefined;
      if (isMethod !== hasTarget) {
        continue;
      }
      let expectedArgs: readonly CelType[];
      let allArgs: CelType[];
      if (isMethod && hasTarget && fn.target && targetType) {
        expectedArgs = [fn.target, ...fn.arguments];
        allArgs = [targetType, ...argTypes];
      } else {
        expectedArgs = fn.arguments;
        allArgs = argTypes;
      }
      if (allArgs.length !== expectedArgs.length) {
        continue;
      }
      let matches = true;
      for (let i = 0; i < allArgs.length; i++) {
        if (!this.isAssignable(expectedArgs[i], allArgs[i])) {
          matches = false;
          break;
        }
      }
      if (matches) {
        matchingOverloads.push({
          resultType: fn.result,
          overloadId: fn.id,
        });
      }
    }
    if (matchingOverloads.length === 0) {
      const allArgsStr = targetType
        ? [targetType, ...argTypes].map((t) => t.toString()).join(", ")
        : argTypes.map((t) => t.toString()).join(", ");
      throw celError(
        `no matching overload for '${fnName}' with arguments [${allArgsStr}]`,
        id,
      );
    }
    if (matchingOverloads.length > 1) {
      return {
        resultType: CelScalar.DYN,
        overloadIds: matchingOverloads.map((o) => o.overloadId),
      };
    }
    return {
      resultType: matchingOverloads[0].resultType,
      overloadIds: [matchingOverloads[0].overloadId],
    };
  }

  private isAssignable(expected: CelType, actual: CelType): boolean {
    if (expected.kind === "scalar" && expected.name === "dyn") {
      return true;
    }
    if (actual.kind === "scalar" && actual.name === "dyn") {
      return true;
    }
    return equalsType(expected, actual);
  }

  private setType(id: bigint, type: CelType): void {
    this.typeMap.set(id, type);
  }

  private setReference(
    id: bigint,
    reference: MessageInitShape<typeof ReferenceSchema>,
  ): void {
    this.referenceMap.set(id, reference);
  }

  /**
   * Resolves a variable according to the CEL name resolution rules.
   *
   * See https://github.com/google/cel-spec/blob/master/doc/langdef.md#name-resolution
   */
  private resolveVariable(name: string):
    | {
        name: string;
        type: CelType;
      }
    | undefined {
    // First we check for the variable to be in
    // the comprehension scope chain if it is not global.
    if (!name.startsWith(".")) {
      const type = this.scope.find(name);
      if (type !== undefined) {
        return {
          type,
          name,
        };
      }
    }
    // It can be a global because either it is fully qualified or missing in comprehension scope.
    for (const candidate of resolveCandidateNames(this.env.namespace, name)) {
      const type = this.env.variables.find(candidate);
      if (type) {
        return {
          type,
          name: candidate, // This is an optimization that allows us to partially skip name resolution during eval.
        };
      }
    }
    return undefined;
  }
}

export function protoTypeToCelType(pt: Type): CelType {
  switch (pt.typeKind.case) {
    case "primitive":
      switch (pt.typeKind.value) {
        case Type_PrimitiveType.BOOL:
          return CelScalar.BOOL;
        case Type_PrimitiveType.BYTES:
          return CelScalar.BYTES;
        case Type_PrimitiveType.DOUBLE:
          return CelScalar.DOUBLE;
        case Type_PrimitiveType.INT64:
          return CelScalar.INT;
        case Type_PrimitiveType.STRING:
          return CelScalar.STRING;
        case Type_PrimitiveType.UINT64:
          return CelScalar.UINT;
      }
      break;
    case "dyn":
      return CelScalar.DYN;
    case "null":
      return CelScalar.NULL;
    case "listType":
      if (!pt.typeKind.value.elemType) {
        throw new Error(`invalid ProtoType listType: ${pt.typeKind.value}`);
      }
      return listType(protoTypeToCelType(pt.typeKind.value.elemType));
    case "mapType":
      if (!pt.typeKind.value.keyType || !pt.typeKind.value.valueType) {
        throw new Error(`invalid ProtoType mapType: ${pt.typeKind.value}`);
      }
      return mapType(
        protoTypeToCelType(pt.typeKind.value.keyType) as mapKeyType,
        protoTypeToCelType(pt.typeKind.value.valueType),
      );
    case "messageType":
      return objectType(pt.typeKind.value);
    case "abstractType":
    case "error":
    case "function":
    case "type":
    case "typeParam":
    case "wellKnown":
    case "wrapper":
      // TODO: handle these types
      break;
  }
  throw new Error(
    `unsupported type passed to protoTypeToCelType: ${pt.typeKind.case}`,
  );
}

function primitiveProtoType(
  primitiveType: Type_PrimitiveType,
): MessageInitShape<typeof TypeSchema> {
  return {
    typeKind: {
      case: "primitive",
      value: primitiveType,
    },
  };
}

const BOOL_TYPE = primitiveProtoType(Type_PrimitiveType.BOOL);
const BYTES_TYPE = primitiveProtoType(Type_PrimitiveType.BYTES);
const DOUBLE_TYPE = primitiveProtoType(Type_PrimitiveType.DOUBLE);
const INT_TYPE = primitiveProtoType(Type_PrimitiveType.INT64);
const STRING_TYPE = primitiveProtoType(Type_PrimitiveType.STRING);
const UINT_TYPE = primitiveProtoType(Type_PrimitiveType.UINT64);
const NULL_TYPE: MessageInitShape<typeof TypeSchema> = {
  typeKind: { case: "null", value: NullValue.NULL_VALUE },
};
const DYN_TYPE: MessageInitShape<typeof TypeSchema> = {
  typeKind: { case: "dyn", value: {} },
};

function listProtoType(
  elemType: MessageInitShape<typeof TypeSchema>,
): MessageInitShape<typeof TypeSchema> {
  return {
    typeKind: {
      case: "listType",
      value: {
        elemType,
      },
    },
  };
}

function mapProtoType(
  keyType: MessageInitShape<typeof TypeSchema>,
  valueType: MessageInitShape<typeof TypeSchema>,
): MessageInitShape<typeof TypeSchema> {
  return {
    typeKind: {
      case: "mapType",
      value: {
        keyType,
        valueType,
      },
    },
  };
}

function objectProtoType(
  typeName: string,
): MessageInitShape<typeof TypeSchema> {
  return {
    typeKind: {
      case: "messageType",
      value: typeName,
    },
  };
}

function celTypeToProtoType(ct: CelType): MessageInitShape<typeof TypeSchema> {
  switch (ct.kind) {
    case "scalar":
      switch (ct.name) {
        case "bool":
          return BOOL_TYPE;
        case "bytes":
          return BYTES_TYPE;
        case "double":
          return DOUBLE_TYPE;
        case "int":
          return INT_TYPE;
        case "string":
          return STRING_TYPE;
        case "uint":
          return UINT_TYPE;
        case "null_type":
          return NULL_TYPE;
        case "dyn":
          return DYN_TYPE;
        case "type":
          // TODO: handle type type
          throw new Error(`unsupported CelType: ${ct.toString()}`);
      }
    case "list":
      return listProtoType(celTypeToProtoType(ct.element));
    case "map":
      return mapProtoType(
        celTypeToProtoType(ct.key),
        celTypeToProtoType(ct.value),
      );
    case "object":
      return objectProtoType(ct.desc ? ct.desc.typeName : ct.name);
  }
}

function celTypeMapToProtoTypeMap(
  typeMap: Map<bigint, CelType>,
): Record<string, MessageInitShape<typeof TypeSchema>> {
  const protoTypeMap: Record<string, MessageInitShape<typeof TypeSchema>> = {};
  for (const [exprId, celType] of typeMap.entries()) {
    protoTypeMap[exprId.toString()] = celTypeToProtoType(celType);
  }
  return protoTypeMap;
}

function identReference(
  name: string,
  value?: CelValue,
): MessageInitShape<typeof ReferenceSchema> {
  return {
    name,
    value: value ? celValueToProtoConstant(value) : undefined,
  };
}

function functionReference(
  name: string,
  overloadIds: string[],
): MessageInitShape<typeof ReferenceSchema> {
  return {
    name,
    overloadId: overloadIds,
  };
}

function protoConstant<
  T extends Exclude<Constant["constantKind"]["case"], undefined>,
>(
  caseName: T,
  value: Extract<Constant["constantKind"], { case: T }>["value"],
): MessageInitShape<typeof ConstantSchema> {
  return {
    constantKind: { case: caseName, value } as Constant["constantKind"],
  };
}

function celValueToProtoConstant(
  value: CelValue,
): MessageInitShape<typeof ConstantSchema> {
  switch (typeof value) {
    case "bigint":
      return protoConstant("int64Value", value);
    case "number":
      return protoConstant("doubleValue", value);
    case "boolean":
      return protoConstant("boolValue", value);
    case "string":
      return protoConstant("stringValue", value);
    case "object":
      switch (true) {
        case isCelUint(value):
          return protoConstant("uint64Value", value.value);
        case null:
          return protoConstant("nullValue", NullValue.NULL_VALUE);
        case value instanceof Uint8Array:
          return protoConstant("bytesValue", value);
      }
  }
  throw new Error(`unsupported constant type: ${celType(value)}`);
}

function celReferenceMapToProtoReferenceMap(
  referenceMap: Map<bigint, MessageInitShape<typeof ReferenceSchema>>,
): Record<string, MessageInitShape<typeof ReferenceSchema>> {
  const protoReferenceMap: Record<
    string,
    MessageInitShape<typeof ReferenceSchema>
  > = {};
  for (const [id, ref] of referenceMap.entries()) {
    protoReferenceMap[id.toString()] = ref;
  }
  return protoReferenceMap;
}
