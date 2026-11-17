# Frozen boundaries

- Mermaid is the durable semantic source; normalized JSON (`schema/diagram-envelope.schema.json`)
  is the service/UI contract.
- Do not independently change public schemas, stable-ID syntax, revision spelling, fixture meanings,
  supported Mermaid syntax, or recorded decisions. Propose contract changes in an issue or pull request.
- Coordinates, viewport, focus, selection, and UI types never enter semantic graph models.
- Unsupported Mermaid syntax must produce diagnostics and must never be silently ignored.
- Missing registry manifests mean an empty inventory; do not add implicit filesystem scanning.
- Mermaid edges require explicit stable IDs; implicit node creation is rejected.
- UI selection never mutates Mermaid source in V1.
- Sequence diagrams use `SequenceTrace` model type; ordering is preserved, not flattened into graph edges.
- Keep model-visible MCP text concise; return complete models through structured content.
