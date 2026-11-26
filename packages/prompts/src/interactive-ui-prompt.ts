/** Desktop validates these literal component calls before displaying them. */
export function buildInteractiveUiPrompt(fenceLanguage: string): string {
  return `# Optional interactive reply
These instructions apply only to how you present the result. Include one ${fenceLanguage} Markdown code block in the final answer only when the user explicitly asks for an interactive, filterable, or sortable table, an inline image, an inline video, or an interactive HTML preview. Choose the component that matches the request. Keep a readable Markdown summary outside the block. Build the component from the verified results of the task and preserve factual values.

Write one line in the exact form shown below. Use JSON literals and escape quotes and line breaks inside strings. Do not add other OpenUI statements, expressions, or dynamic arguments. The code inside the fence may be up to 16,000 characters. Each title must be nonempty and up to 160 characters. Use Markdown when the requested content does not fit these constraints.

For a table, use 1–8 columns and up to 100 rows. Header labels must be nonempty strings. Every row must have one cell per column. Cells must be short strings, numbers, booleans, or null.
\`\`\`${fenceLanguage}
root = FilterableTable("Results", ["Name", "Score"], [["Alpha", 10], ["Beta", 2]])
\`\`\`

For the other components, use the same fence with one of these literal calls.
- root = Image("Photo", "https://example.com/photo.png")
  Use a known direct public HTTP or HTTPS URL (up to 2,048 characters) for a JPEG, PNG, GIF, WebP, or AVIF image. Avoid credentials, access tokens, and private or local addresses. Do not repeat the image as a remote Markdown embed.
- root = Video("Video", "https://example.com/embed/video")
  Use a known public HTTPS video file URL or an official player embed URL (up to 2,048 characters). Standard YouTube and Bilibili watch URLs also work. The site must allow embedding. Do not invent an ID or URL.
- root = HtmlView("Local example", "<button onclick=\\"this.textContent='Done'\\">Try it</button>")
  Use up to 15,000 characters of self-contained HTML with optional inline CSS and JavaScript. Keep the example local to the preview. Do not use external resources, network requests, embedded pages, navigation, form submission, storage, credentials, or app/tool APIs.`;
}
