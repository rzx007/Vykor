import { createPluginAppClient, definePluginAppTool, type PluginAppTool } from "@vykor/plugins/app-client";

interface SearchInput { query: string }
interface SearchOutput { items: Array<{ id: string; title: string }> }
const tools = {
  search: definePluginAppTool<SearchInput, SearchOutput>("search_notes"),
  list: definePluginAppTool<Record<string, never>, { count: number }>("list_notes"),
};
const declared: PluginAppTool<SearchInput, SearchOutput> = tools.search;
const app = {
  async callServerTool(_request: { name: string; arguments?: Record<string, unknown> }, _options?: { signal?: AbortSignal; timeout?: number }) {
    return { content: [{ type: "text", text: "ok" }], structuredContent: {} as Record<string, unknown>, isError: false, _meta: { receipt: "original" } };
  },
};
const client = createPluginAppClient(app);
async function checkTypes() {
  const result = await client.call(declared, { query: "hello" }, { signal: new AbortController().signal, timeout: 1000 });
  const title: string | undefined = result.structuredContent?.items[0]?.title;
  const text: string | undefined = result.content[0]?.text;
  const receipt: string = result._meta.receipt;
  const error: boolean = result.isError;
  void [title, text, receipt, error];
  await client.call(tools.list, {});
  // @ts-expect-error The tool map supplies completion and rejects misspelled names.
  await client.call(tools.seach, { query: "hello" });
  // @ts-expect-error A descriptor is required instead of an unchecked string.
  await client.call("search_notes", { query: "hello" });
  // @ts-expect-error Required input is checked.
  await client.call(tools.search, {});
  // @ts-expect-error Input is inferred from the tool, not widened by the argument.
  await client.call(tools.search, { query: 42 });
  // @ts-expect-error Unknown input fields are rejected for object literals.
  await client.call(tools.search, { query: "hello", typo: true });
  // @ts-expect-error A no-input tool still requires an empty argument object.
  await client.call(tools.list, { query: "hello" });
  // @ts-expect-error Transport options retain their original types.
  await client.call(tools.search, { query: "hello" }, { timeout: "soon" });
  // @ts-expect-error Structured output does not contain this field.
  result.structuredContent?.unknown;
  // @ts-expect-error Structured output can be absent; page validation is still required.
  result.structuredContent.items;
}
void checkTypes;
