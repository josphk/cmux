You are working on the cmux browser-bridge feature. Your task is to write the **JavaScript injection script** for browser element inspection/picking mode.

## Output

Write the complete JS to: `features/browser-bridge/inspection-mode.js`

## Requirements

This script gets injected into a WKWebView page. It must:

1. **Hover overlay**: A `position:fixed` semi-transparent blue rectangle that tracks the hovered element via `getBoundingClientRect()`. Use `pointer-events:none` on the overlay so it doesn't intercept clicks.

2. **Tooltip**: Show `role: "label text"` in a small tooltip below the hovered element. Style it with dark background, light text, small font.

3. **Crosshair cursor**: Inject a `<style>` tag that sets `cursor: crosshair` on `*`.

4. **Click intercept**: Add a capture-phase click listener that calls `preventDefault()` + `stopImmediatePropagation()`, then posts element data.

5. **Post to Swift**: On click, call `window.webkit.messageHandlers.cmuxInspect.postMessage(data)` with the element data object.

6. **Multi-pick**: Do NOT exit inspection mode after a click. Instead, briefly flash the clicked element green (200ms green border), then resume inspection. The user stays in pick mode until Swift calls `window.__cmuxInspectCleanup()`.

7. **Cleanup function**: `window.__cmuxInspectCleanup()` must remove ALL injected DOM elements (overlay, tooltip, style tags), remove ALL event listeners, and restore the original cursor.

8. **Selector generation**: Build a CSS selector for the clicked element:
   - Prefer `[data-testid="value"]` if present
   - Then `#id` if the element has an ID
   - Then shortest unique `tag.class` or `tag[attr]` combo
   - Walk up max 3 ancestor levels for uniqueness
   - If no short unique selector, just use `tagName`

9. **Role detection**: Determine the element's ARIA role:
   - Use explicit `role` attribute if present
   - Otherwise infer: `<button>`→button, `<a>`→link, `<input type="text">`→textbox, `<input type="checkbox">`→checkbox, `<input type="radio">`→radio, `<select>`→combobox, `<img>`→img, `<h1>`-`<h6>`→heading, `<textarea>`→textbox
   - Default to tagName.toLowerCase()

10. **Label extraction**: Get the element's accessible label:
    - `aria-label` attribute first
    - Then text from `aria-labelledby` referenced element
    - Then `textContent` trimmed and truncated to 80 chars with `…` suffix

11. **iframe handling**: If the hovered element is an `<iframe>`, show tooltip: "iframe — inner elements not supported"

12. **Element data shape** posted on click:
```json
{
  "selector": "form > button.primary-submit",
  "text": "Submit Form",
  "role": "button",
  "tagName": "BUTTON",
  "attributes": { "type": "submit", "class": "primary-submit" },
  "url": "http://localhost:3000/login",
  "pageTitle": "Login — My App"
}
```

The `attributes` object should include: type, class, id, name, href, src, alt, placeholder, data-testid, value (for inputs), aria-label.

## Style Guidelines

- Use an IIFE wrapper `(function() { ... })()` to avoid polluting global scope
- All injected DOM elements should have a `data-cmux-inspect` attribute for easy cleanup
- Overlay color: `rgba(59, 130, 246, 0.15)` with `2px solid rgba(59, 130, 246, 0.6)` border
- Flash color on pick: `rgba(34, 197, 94, 0.3)` border for 200ms
- Tooltip: `background: rgba(0,0,0,0.85)`, `color: white`, `font-size: 11px`, `padding: 4px 8px`, `border-radius: 4px`
- Z-index for all injected elements: `2147483647` (max)

## Testing

The script should be testable by pasting it into any browser's dev console. After pasting:
- Hovering should show the blue overlay + tooltip
- Clicking should log to console (since messageHandlers won't exist outside WKWebView — add a fallback `console.log` for testing)
- `window.__cmuxInspectCleanup()` should remove everything

When done, just say "Stream A complete" and stop.
