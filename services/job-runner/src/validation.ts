import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import { ApiError } from "./errors.js";
const ajv = new Ajv2020({
  strict: false,
  allErrors: false,
  validateFormats: true,
});
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
export const runnerContract = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
);
export const providerContract = JSON.parse(
  readFileSync(new URL("../provider.openapi.json", import.meta.url), "utf8"),
);
ajv.addSchema(runnerContract, "runner");
ajv.addSchema(providerContract, "provider");
const validators = new Map<string, ValidateFunction>();
export function validate(
  kind: "runner" | "provider",
  name: string,
  value: unknown,
) {
  const key = kind + name;
  let fn = validators.get(key);
  if (!fn) {
    fn = ajv.compile({ $ref: `${kind}#/components/schemas/${name}` });
    validators.set(key, fn);
  }
  if (!fn(value))
    throw new ApiError(
      422,
      "invalid_request",
      "Payload does not match the approved schema",
    );
}
export function workloadValidator(schema: Record<string, unknown>) {
  return ajv.compile(schema);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value !== null)
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  throw new ApiError(
    422,
    "invalid_request",
    "Only finite JSON values are supported",
  );
}
export const fingerprint = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
