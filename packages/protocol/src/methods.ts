import { z } from "zod";

/**
 * Bumped only for breaking changes to the method set or payloads. The UI refuses to talk to an
 * engine with a different major protocol version.
 */
export const PROTOCOL_VERSION = 1;

export const EnginePingResult = z.object({
  engineVersion: z.string(),
  protocolVersion: z.int(),
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
  }),
  /** Unix milliseconds when the engine process started. */
  startedAt: z.int(),
});
export type EnginePingResult = z.infer<typeof EnginePingResult>;

/**
 * Every engine method, declared once. Params and results are validated on both sides of the
 * wire.
 */
export const methods = {
  "engine.ping": {
    params: z.strictObject({}),
    result: EnginePingResult,
  },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type MethodParams<M extends MethodName> = z.input<Methods[M]["params"]>;
export type MethodResult<M extends MethodName> = z.output<Methods[M]["result"]>;

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}
