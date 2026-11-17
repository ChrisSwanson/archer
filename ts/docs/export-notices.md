# Notices in Local Exports

Local `export_diagram` operations, including CLI, MCP and browser downloads, read the
project root's `NOTICE.md` for every export. SVG carries the complete UTF-8 text in
`metadata#archer-project-notice`. PNG carries it in an uncompressed UTF-8 `iTXt`
chunk with the keyword `Copyright`. Projects without that file export as before.
An unreadable, symbolic or hard linked, invalid UTF-8 or oversized notice refuses export rather than
silently dropping its terms. The maximum notice size is 100,000 bytes.

Set the optional `noticeCaption: true` argument on `export_diagram` to draw the
complete notice below the drawing, using the export's measured font and wrapping.
The caption retains the metadata too. To bound layout work, visible captions are
limited to 10,000 characters, 1,024 per paragraph and 256 per word; exceeding
those limits refuses the caption rather than truncating it. Metadata keeps the
full notice within the 100,000-byte limit. For example, from a project directory:

```sh
printf '%s' '{"viewId":"brew-decisions","format":"png","noticeCaption":true}' \
  | archer call export_diagram --stdin --output brew-with-notice.png
```

The internal TypeScript exporter also accepts `projectNotice` and `noticeCaption`
in `ExportOptions`. The browser download uses embedded notices automatically;
there is no new browser control for the optional caption.

Image editors, screenshots and format conversions can strip metadata. Keep a copy
of `NOTICE.md` beside converted or detached images when distributing them. JSON
walkthroughs and emphasis recipes do not embed notices; distribute those files with
the notice too. Site-generated pages display the project notice and provide it
beside their SVG downloads through the separate site pipeline.

This handling does not change schema-v2 diagram envelopes, the project manifest or
walkthrough sidecars. `noticeCaption` is an optional public operation argument;
existing callers retain their previous dimensions and drawing.
