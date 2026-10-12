import { useEffect, useMemo, useState } from "react";
import { readDirectoryTree, type DirectoryTree, type DirectoryTreeNode } from "../lib/shell";

interface Point { x: number; y: number; }

function arrange(nodes: DirectoryTreeNode[]) {
  const children = new Map<number, DirectoryTreeNode[]>();
  for (const node of nodes) {
    if (node.parentId !== null) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  const points = new Map<number, Point>();
  let leaf = 0;
  const place = (node: DirectoryTreeNode) => {
    const descendants = children.get(node.id) ?? [];
    const start = leaf;
    if (descendants.length) descendants.forEach(place);
    else leaf += 1;
    const y = descendants.length ? (points.get(descendants[0].id)!.y + points.get(descendants[descendants.length - 1].id)!.y) / 2 : 72 + start * 66;
    const depth = node.depth;
    points.set(node.id, { x: 80 + depth * 230, y: y + ((node.id * 37) % 9 - 4) * 3 });
  };
  if (nodes[0]) place(nodes[0]);
  return { points, height: Math.max(340, 150 + leaf * 66), width: Math.max(900, 220 + (Math.max(0, ...nodes.map((node) => node.depth)) + 1) * 230) };
}

function bytes(size: number | null) {
  if (size === null) return "Folder";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function DirectoryGraph({ initialPath, onClose }: { initialPath: string; onClose: () => void }) {
  const [path, setPath] = useState(initialPath);
  const [history, setHistory] = useState<string[]>([]);
  const [tree, setTree] = useState<DirectoryTree | null>(null);
  const [selected, setSelected] = useState<number>(0);
  const [query, setQuery] = useState("");
  const [showFiles, setShowFiles] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError("");
    void readDirectoryTree(path).then((result) => {
      if (!cancelled) { setTree(result); setSelected(0); }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(String(reason));
    });
    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);

  const layout = useMemo(() => tree ? arrange(tree.nodes) : null, [tree]);
  const nodeMap = useMemo(() => new Map((tree?.nodes ?? []).map((node) => [node.id, node])), [tree]);
  const visible = useMemo(() => {
    if (!tree) return new Set<number>();
    const matches = new Set<number>();
    const needle = query.trim().toLowerCase();
    for (const node of tree.nodes) {
      if ((!showFiles && !node.isDirectory) || (needle && !node.name.toLowerCase().includes(needle) && !node.path.toLowerCase().includes(needle))) continue;
      let current: DirectoryTreeNode | undefined = node;
      while (current) {
        matches.add(current.id);
        current = current.parentId === null ? undefined : nodeMap.get(current.parentId);
      }
    }
    return matches;
  }, [tree, query, showFiles, nodeMap]);
  const activeNode = nodeMap.get(selected);

  const openDirectory = (node: DirectoryTreeNode) => {
    if (!node.isDirectory) return;
    setHistory((current) => [...current, path]);
    setPath(node.path);
  };
  const goBack = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((current) => current.slice(0, -1));
    setPath(previous);
  };

  return (
    <section className="directory-graph" aria-label="Directory network explorer">
      <header className="directory-graph-header">
        <div><span className="directory-graph-mark">✳</span><div><strong>Directory network</strong><small>{tree ? `${tree.nodes.length} nodes · depth ${Math.max(0, ...tree.nodes.map((node) => node.depth))}` : "Scanning files…"}</small></div></div>
        <button className="directory-graph-close" onClick={onClose}>Close <span>Esc</span></button>
      </header>
      <div className="directory-graph-toolbar">
        <button disabled={!history.length} onClick={goBack}>← Back</button>
        <code title={path}>{path}</code>
        <label><input type="checkbox" checked={showFiles} onChange={(event) => setShowFiles(event.target.checked)} /> Files</label>
        <input className="directory-graph-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter nodes…" />
      </div>
      <div className="directory-graph-content">
        <div className="directory-graph-canvas">
          {error ? <div className="directory-graph-message">{error}</div> : !tree || !layout ? <div className="directory-graph-message">Mapping this directory…</div> : (
            <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Files and folders connected by their directory hierarchy">
              <defs>
                <linearGradient id="network-depth" x1="0" x2="1"><stop offset="0" stopColor="var(--accent)" /><stop offset="1" stopColor="var(--log-info)" /></linearGradient>
                <filter id="node-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
              </defs>
              {tree.nodes.map((node) => {
                if (!visible.has(node.id) || node.parentId === null) return null;
                const parent = layout.points.get(node.parentId)!;
                const point = layout.points.get(node.id)!;
                const curve = (parent.x + point.x) / 2;
                return <path key={`edge-${node.id}`} className={`network-edge${selected === node.id ? " selected" : ""}`} d={`M ${parent.x + 45} ${parent.y} C ${curve} ${parent.y}, ${curve} ${point.y}, ${point.x - 12} ${point.y}`} />;
              })}
              {tree.nodes.map((node) => {
                if (!visible.has(node.id)) return null;
                const point = layout.points.get(node.id)!;
                const chosen = selected === node.id;
                const scale = Math.max(0.65, 1 - node.depth * 0.07);
                return (
                  <g key={node.id} className={`network-node${chosen ? " selected" : ""}${node.isDirectory ? " directory" : " file"}`} transform={`translate(${point.x} ${point.y}) scale(${scale})`} onClick={() => setSelected(node.id)} onDoubleClick={() => openDirectory(node)}>
                    <circle className="network-node-halo" r={chosen ? 25 : 20} />
                    <circle className="network-node-core" r={chosen ? 13 : 10} />
                    <text x="24" y="-3">{node.isDirectory ? "▰" : "·"} {node.name}</text>
                    <text className="network-node-meta" x="24" y="14">{node.isDirectory ? "DIRECTORY" : bytes(node.size).toUpperCase()}</text>
                  </g>
                );
              })}
              {Array.from({ length: Math.max(0, ...tree.nodes.map((node) => node.depth)) + 1 }, (_, depth) => <text key={`depth-${depth}`} className="network-depth-label" x={80 + depth * 230} y="28">{depth === 0 ? "ROOT" : `LEVEL ${depth}`}</text>)}
            </svg>
          )}
        </div>
        <aside className="directory-graph-inspector">
          <span className="directory-graph-eyebrow">SELECTED NODE</span>
          {activeNode ? <>
            <h2>{activeNode.isDirectory ? "▰" : "·"} {activeNode.name}</h2>
            <p>{activeNode.path}</p>
            <dl><dt>Type</dt><dd>{activeNode.isDirectory ? "Directory" : "File"}</dd><dt>Depth</dt><dd>{activeNode.depth}</dd><dt>Size</dt><dd>{bytes(activeNode.size)}</dd></dl>
            {activeNode.isDirectory && <button className="directory-open-button" onClick={() => openDirectory(activeNode)}>Explore folder <span>↗</span></button>}
          </> : <p>Select a node in the network.</p>}
          {tree?.truncated && <p className="directory-graph-limit">Showing a limited snapshot. Explore a folder to see more.</p>}
          <div className="directory-graph-legend"><span><i className="legend-dir" /> Folder</span><span><i className="legend-file" /> File</span><small>Double-click a folder to explore it</small></div>
        </aside>
      </div>
    </section>
  );
}
