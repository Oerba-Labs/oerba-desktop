/** js-yaml ships no types and the app does not use it: only the release script and its test do. These are the two calls they make. */
declare module "js-yaml" {
  const yaml: {
    load(text: string, options?: unknown): unknown;
    dump(value: unknown, options?: unknown): string;
    CORE_SCHEMA: unknown;
  };
  export default yaml;
}
