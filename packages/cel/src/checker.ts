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
  Expr_Select,
  Expr_CreateStruct,
  Expr_Comprehension,
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
import { create, type MessageInitShape, ScalarType } from "@bufbuild/protobuf";
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
      case "selectExpr":
        return this.checkSelectExpr(expr.id, expr.exprKind.value);
      case "structExpr":
        return this.checkStructExpr(expr.id, expr.exprKind.value);
      case "comprehensionExpr":
        return this.checkComprehensionExpr(expr.id, expr.exprKind.value);
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
      const elemType = this.getExprType(elem.id);
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

  /**
   * Get the type of an expression from the type map.
   * Throws an error if the type is not found.
   */
  private getExprType(id: bigint): CelType {
    const type = this.typeMap.get(id);
    if (!type) {
      throw celError(`expression has no type`, id);
    }
    return type;
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
      targetType = this.getExprType(call.target.id);
    }
    const args: MessageInitShape<typeof ExprSchema>[] = [];
    const argTypes: CelType[] = [];
    for (const arg of call.args) {
      args.push(this.checkExpr(arg));
      argTypes.push(this.getExprType(arg.id));
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

  private checkSelectExpr(
    id: bigint,
    select: Expr_Select,
  ): MessageInitShape<typeof ExprSchema> {
    if (!select.operand) {
      throw celError("select expression missing operand", id);
    }

    // Check the operand
    const operand = this.checkExpr(select.operand);
    const operandType = this.getExprType(select.operand.id);

    // If test_only is true, this is a has() presence test - result is always bool
    if (select.testOnly) {
      this.setType(id, CelScalar.BOOL);
      return {
        id,
        exprKind: {
          case: "selectExpr",
          value: {
            operand,
            field: select.field,
            testOnly: true,
          },
        },
      };
    }

    // Determine the result type based on the operand type
    let resultType: CelType;

    switch (operandType.kind) {
      case "object": {
        // Proto message field access
        if (!operandType.desc) {
          throw celError(`cannot access field on undefined object type`, id);
        }
        const field = operandType.desc.fields.find(
          (f) => f.name === select.field,
        );
        if (!field) {
          throw celError(
            `field '${select.field}' not found on type '${operandType.desc.typeName}'`,
            id,
          );
        }
        resultType = this.descFieldToCelType(field);
        break;
      }

      case "map": {
        // Map field access returns the value type
        resultType = operandType.value;
        break;
      }

      case "scalar": {
        if (operandType.name === "dyn") {
          // DYN type - allow any field access, result is DYN
          resultType = CelScalar.DYN;
        } else {
          throw celError(
            `field access not supported on scalar type '${operandType.name}'`,
            id,
          );
        }
        break;
      }

      case "list": {
        throw celError(`field access not supported on list type`, id);
      }

      default:
        throw celError(`unsupported operand type for field access`, id);
    }

    this.setType(id, resultType);

    return {
      id,
      exprKind: {
        case: "selectExpr",
        value: {
          operand,
          field: select.field,
          testOnly: false,
        },
      },
    };
  }

  private checkStructExpr(
    id: bigint,
    struct: Expr_CreateStruct,
  ): MessageInitShape<typeof ExprSchema> {
    // Distinguish between map literals and message literals
    if (struct.messageName === "") {
      // Map literal: {key: value, ...}
      return this.checkMapLiteral(id, struct);
    }
    // Message/struct literal: TypeName{field: value, ...}
    return this.checkMessageLiteral(id, struct);
  }

  private checkMapLiteral(
    id: bigint,
    struct: Expr_CreateStruct,
  ): MessageInitShape<typeof ExprSchema> {
    const entries: MessageInitShape<
      typeof ExprSchema
    >["exprKind"]["value"]["entries"] = [];
    let keyType: CelType | undefined = undefined;
    let valueType: CelType | undefined = undefined;

    for (const entry of struct.entries) {
      if (!entry.keyKind || entry.keyKind.case !== "mapKey") {
        throw celError(`map entry must have mapKey, not fieldKey`, entry.id);
      }

      // Check key expression
      const keyExpr = this.checkExpr(entry.keyKind.value);
      const entryKeyType = this.getExprType(entry.keyKind.value.id);

      // Check value expression
      if (!entry.value) {
        throw celError(`map entry missing value`, entry.id);
      }
      const valueExpr = this.checkExpr(entry.value);
      const entryValueType = this.getExprType(entry.value.id);

      // Join types - if different types seen, result becomes DYN
      if (keyType === undefined) {
        keyType = entryKeyType;
      } else if (!equalsType(keyType, entryKeyType)) {
        keyType = CelScalar.DYN;
      }

      if (valueType === undefined) {
        valueType = entryValueType;
      } else if (!equalsType(valueType, entryValueType)) {
        valueType = CelScalar.DYN;
      }

      entries.push({
        id: entry.id,
        keyKind: {
          case: "mapKey",
          value: keyExpr,
        },
        value: valueExpr,
        optionalEntry: entry.optionalEntry,
      });
    }

    // Empty map defaults to map(dyn, dyn)
    const resultType = mapType(
      (keyType ?? CelScalar.DYN) as mapKeyType,
      valueType ?? CelScalar.DYN,
    );

    this.setType(id, resultType);

    return {
      id,
      exprKind: {
        case: "structExpr",
        value: {
          messageName: "",
          entries,
        },
      },
    };
  }

  private checkMessageLiteral(
    id: bigint,
    struct: Expr_CreateStruct,
  ): MessageInitShape<typeof ExprSchema> {
    // Look up the message type
    const candidates = resolveCandidateNames(
      this.env.namespace,
      struct.messageName,
    );

    let msgType: CelType | undefined = undefined;
    let resolvedName: string | undefined = undefined;

    for (const candidate of candidates) {
      const decl = this.env.variables.find(candidate);
      if (decl) {
        msgType = decl.type;
        resolvedName = candidate;
        break;
      }
    }

    if (!msgType || !resolvedName) {
      throw celError(
        `undeclared reference to '${struct.messageName}' (in container '${this.env.namespace}')`,
        id,
      );
    }

    if (msgType.kind !== "object") {
      throw celError(`'${struct.messageName}' is not a message type`, id);
    }

    if (!msgType.desc) {
      throw celError(
        `message type '${struct.messageName}' has no descriptor`,
        id,
      );
    }

    const desc = msgType.desc;
    const entries: MessageInitShape<
      typeof ExprSchema
    >["exprKind"]["value"]["entries"] = [];

    // Check each field entry
    for (const entry of struct.entries) {
      if (!entry.keyKind || entry.keyKind.case !== "fieldKey") {
        throw celError(
          `message entry must have fieldKey, not mapKey`,
          entry.id,
        );
      }

      const fieldName = entry.keyKind.value;
      const field = desc.fields.find((f) => f.name === fieldName);

      if (!field) {
        throw celError(
          `field '${fieldName}' not found on type '${desc.typeName}'`,
          entry.id,
        );
      }

      // Check value expression
      if (!entry.value) {
        throw celError(`message field '${fieldName}' missing value`, entry.id);
      }

      const valueExpr = this.checkExpr(entry.value);
      const valueType = this.getExprType(entry.value.id);
      const expectedType = this.descFieldToCelType(field);

      // Check type assignability
      if (!this.isAssignable(expectedType, valueType)) {
        throw celError(
          `type mismatch: cannot assign ${valueType} to field '${fieldName}' of type ${expectedType}`,
          entry.id,
        );
      }

      entries.push({
        id: entry.id,
        keyKind: {
          case: "fieldKey",
          value: fieldName,
        },
        value: valueExpr,
        optionalEntry: entry.optionalEntry,
      });
    }

    this.setType(id, msgType);
    this.setReference(id, { name: resolvedName });

    return {
      id,
      exprKind: {
        case: "structExpr",
        value: {
          messageName: resolvedName,
          entries,
        },
      },
    };
  }

  private checkComprehensionExpr(
    id: bigint,
    comp: Expr_Comprehension,
  ): MessageInitShape<typeof ExprSchema> {
    // Check the iteration range to determine what we're iterating over
    if (!comp.iterRange) {
      throw celError("comprehension missing iterRange", id);
    }

    const iterRange = this.checkExpr(comp.iterRange);
    const iterRangeType = this.getExprType(comp.iterRange.id);

    // Determine iteration variable types based on the range type
    let iterVarType: CelType;
    let iterVar2Type: CelType | undefined = undefined;

    switch (iterRangeType.kind) {
      case "list": {
        // List iteration: iter_var gets element type, iter_var2 gets index (int)
        iterVarType = iterRangeType.element;
        if (comp.iterVar2) {
          iterVar2Type = CelScalar.INT;
        }
        break;
      }

      case "map": {
        // Map iteration: iter_var gets key type, iter_var2 gets value type
        iterVarType = iterRangeType.key;
        if (comp.iterVar2) {
          iterVar2Type = iterRangeType.value;
        }
        break;
      }

      case "scalar": {
        if (iterRangeType.name === "dyn") {
          // DYN type: both variables get DYN
          iterVarType = CelScalar.DYN;
          if (comp.iterVar2) {
            iterVar2Type = CelScalar.DYN;
          }
        } else {
          throw celError(
            `cannot iterate over scalar type '${iterRangeType.name}'`,
            id,
          );
        }
        break;
      }

      default:
        throw celError(`cannot iterate over this type`, id);
    }

    // Create scope with iteration variables
    const scopeVars: Record<string, CelType> = {
      [comp.iterVar]: iterVarType,
    };
    if (comp.iterVar2 && iterVar2Type) {
      scopeVars[comp.iterVar2] = iterVar2Type;
    }

    // Also add accumulator variable to scope
    if (comp.accuVar) {
      // Check accumulator init to get its type
      if (comp.accuInit) {
        const accuInit = this.checkExpr(comp.accuInit);
        const accuInitType = this.getExprType(comp.accuInit.id);
        scopeVars[comp.accuVar] = accuInitType;
      } else {
        scopeVars[comp.accuVar] = CelScalar.DYN;
      }
    }

    // Push scope
    const previousScope = this.scope;
    this.scope = this.scope.push(scopeVars);

    try {
      // Check loop condition if present
      let loopCondition: MessageInitShape<typeof ExprSchema> | undefined =
        undefined;
      if (comp.loopCondition) {
        loopCondition = this.checkExpr(comp.loopCondition);
        const condType = this.getExprType(comp.loopCondition.id);
        // Condition should be bool, but we don't error if it's DYN
        if (
          condType.kind === "scalar" &&
          condType.name !== "bool" &&
          condType.name !== "dyn"
        ) {
          throw celError(
            `loop condition must be bool, got ${condType.name}`,
            comp.loopCondition.id,
          );
        }
      }

      // Check loop step if present
      let loopStep: MessageInitShape<typeof ExprSchema> | undefined = undefined;
      if (comp.loopStep) {
        loopStep = this.checkExpr(comp.loopStep);
      }

      // Check result expression
      let result: MessageInitShape<typeof ExprSchema> | undefined = undefined;
      let resultType: CelType = CelScalar.DYN;
      if (comp.result) {
        result = this.checkExpr(comp.result);
        resultType = this.getExprType(comp.result.id);
      }

      // Set the result type
      this.setType(id, resultType);

      return {
        id,
        exprKind: {
          case: "comprehensionExpr",
          value: {
            iterVar: comp.iterVar,
            iterVar2: comp.iterVar2,
            iterRange,
            accuVar: comp.accuVar,
            accuInit: comp.accuInit ? this.checkExpr(comp.accuInit) : undefined,
            loopCondition,
            loopStep,
            result,
          },
        },
      };
    } finally {
      // Pop scope
      this.scope = previousScope;
    }
  }

  /**
   * Convert a protobuf field descriptor to a CEL type.
   */
  private descFieldToCelType(
    field: import("@bufbuild/protobuf").DescField,
  ): CelType {
    switch (field.fieldKind) {
      case "scalar": {
        // Map protobuf scalar types to CEL types
        return this.scalarToCelType(field.scalar);
      }

      case "enum":
        // Enums are represented as int in CEL
        return CelScalar.INT;

      case "message":
        // Message types become object types
        return objectType(field.message);

      case "list": {
        // List fields - get element type based on listKind
        switch (field.listKind) {
          case "scalar":
            return listType(this.scalarToCelType(field.scalar));
          case "enum":
            return listType(CelScalar.INT);
          case "message":
            return listType(objectType(field.message));
        }
        break;
      }

      case "map": {
        // Map fields - get key and value types
        // Key is always a scalar (and must be a valid map key type)
        const keyType = this.scalarToCelType(field.mapKey) as mapKeyType;

        // Value type depends on mapKind
        let valueType: CelType;
        switch (field.mapKind) {
          case "scalar":
            valueType = this.scalarToCelType(field.scalar);
            break;
          case "enum":
            valueType = CelScalar.INT;
            break;
          case "message":
            valueType = objectType(field.message);
            break;
        }

        return mapType(keyType, valueType);
      }
    }
  }

  /**
   * Helper to convert protobuf scalar type to CEL type.
   */
  private scalarToCelType(scalar: ScalarType): CelType {
    switch (scalar) {
      case ScalarType.DOUBLE:
      case ScalarType.FLOAT:
        return CelScalar.DOUBLE;
      case ScalarType.INT64:
      case ScalarType.INT32:
      case ScalarType.SINT32:
      case ScalarType.SINT64:
      case ScalarType.SFIXED32:
      case ScalarType.SFIXED64:
        return CelScalar.INT;
      case ScalarType.UINT64:
      case ScalarType.UINT32:
      case ScalarType.FIXED32:
      case ScalarType.FIXED64:
        return CelScalar.UINT;
      case ScalarType.BOOL:
        return CelScalar.BOOL;
      case ScalarType.STRING:
        return CelScalar.STRING;
      case ScalarType.BYTES:
        return CelScalar.BYTES;
      default:
        throw new Error(`unknown scalar type: ${scalar}`);
    }
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
