/**
 * Ambient module declarations for optional dependencies.
 *
 * These packages are only imported when the corresponding feature is enabled,
 * so they are not declared in package.json dependencies. The declarations
 * keep the type checker happy; the runtime import is wrapped in try/catch
 * with a graceful fallback (see src/search/factory.ts).
 */
declare module "@huggingface/transformers" {
  export function pipeline(
    task: string,
    model: string,
    opts?: unknown,
  ): Promise<(input: string | string[], opts?: { pooling?: string; normalize?: boolean }) => Promise<{ data: Float32Array | number[]; dims: number[] }>>;
}
