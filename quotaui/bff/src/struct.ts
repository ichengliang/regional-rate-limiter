// google.protobuf.Struct <-> plain-JS-object codec.
//
// @grpc/proto-loader does NOT auto-convert Struct: it stays in wire form
// `{ fields: { key: Value } }`, where Value is a oneof (numberValue / stringValue
// / boolValue / nullValue / structValue / listValue). The audit rows (old_row /
// new_row) are JSONB → Struct on the wire, so the BFF decodes them to plain
// objects for the SPA. `objectToStruct` is the inverse (used by test stubs and
// available for symmetry).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function valueToJs(v: Any): unknown {
  if (v == null) return null;
  switch (v.kind) {
    case "nullValue":
      return null;
    case "numberValue":
      return v.numberValue;
    case "stringValue":
      return v.stringValue;
    case "boolValue":
      return v.boolValue;
    case "structValue":
      return structToObject(v.structValue);
    case "listValue":
      return (v.listValue?.values ?? []).map(valueToJs);
    default:
      return null;
  }
}

export function structToObject(s: Any): Record<string, unknown> | null {
  if (s == null) return null;
  if (!s.fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.fields)) out[k] = valueToJs(v);
  return out;
}

function jsToValue(x: unknown): Any {
  if (x === null || x === undefined) return { nullValue: "NULL_VALUE" };
  switch (typeof x) {
    case "number":
      return { numberValue: x };
    case "boolean":
      return { boolValue: x };
    case "string":
      return { stringValue: x };
    case "object":
      if (Array.isArray(x)) return { listValue: { values: x.map(jsToValue) } };
      return { structValue: objectToStruct(x as Record<string, unknown>) };
    default:
      return { nullValue: "NULL_VALUE" };
  }
}

export function objectToStruct(obj: Record<string, unknown>): Any {
  const fields: Record<string, Any> = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = jsToValue(v);
  return { fields };
}
