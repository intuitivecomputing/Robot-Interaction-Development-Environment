import React, { useEffect, useState, useRef } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, BaseEdge, EdgeLabelRenderer, MarkerType, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import EditableNode from './EditableNode';

const nodeTypes = { editableNode: EditableNode };

// Initialize the ELK layout engine
const elk = new ELK();

// Make sure these match your EditableNode CSS exactly to prevent line clipping
const nodeWidth = 220;
const nodeHeight = 80;

// Rough sizing for a wrapped edge label, so ELK reserves real room for it
// (formatEdgeLabel wraps roughly every 10 characters per line)
const LABEL_LINE_HEIGHT = 16;
const LABEL_CHAR_WIDTH = 7;
const LABEL_PADDING_X = 24;
const LABEL_PADDING_Y = 12;

const estimateLabelSize = (wrappedText) => {
  if (!wrappedText) return { width: 0, height: 0 };
  const lines = wrappedText.split('\n');
  const longestLine = Math.max(...lines.map((l) => l.length));
  return {
    width: longestLine * LABEL_CHAR_WIDTH + LABEL_PADDING_X,
    height: lines.length * LABEL_LINE_HEIGHT + LABEL_PADDING_Y,
  };
};

// Custom edge that renders ELK's own computed orthogonal route (bend points)
// instead of letting React Flow auto-route it, so parallel/back edges get
// properly separated exactly as ELK's spacing options intend.
function ElkRoutedEdge({ id, data, markerEnd, style }) {
  const points = data?.points || [];
  if (points.length < 2) return null;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {data?.label && data.labelX != null && data.labelY != null && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${data.labelX}px, ${data.labelY}px)`,
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 11,
              fontWeight: 700,
              color: '#334155',
              whiteSpace: 'pre-line',
              textAlign: 'center',
              lineHeight: 1.3,
              pointerEvents: 'none',
              zIndex: 10,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { elkEdge: ElkRoutedEdge };

// How far a self-loop (a node pointing back to itself) bulges out to the
// right of its node. ELK's layered algorithm has no "layer transition" to
// route these through, so they're built by hand off of the node's own
// laid-out position instead of being sent through ELK at all.
const SELF_LOOP_BULGE = 70;
const SELF_LOOP_STAGGER = 40;

const buildSelfLoopPoints = (node, index = 0) => {
  const centerX = node.position.x + nodeWidth / 2;
  const bottomY = node.position.y + nodeHeight;
  const topY = node.position.y;
  const loopX = node.position.x + nodeWidth + SELF_LOOP_BULGE + index * SELF_LOOP_STAGGER;

  return [
    { x: centerX, y: bottomY },
    { x: loopX, y: bottomY },
    { x: loopX, y: topY },
    { x: centerX, y: topY },
  ];
};

const getLayoutedElements = async (nodes, edges) => {
  //Filter valid nodes in case AI hallucinates
  const validNodeIds = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter(
    (e) => validNodeIds.has(e.source) && validNodeIds.has(e.target)
  );

  // Self-loops aren't a layer-to-layer transition ELK can route, so they're
  // excluded from the graph handed to ELK and routed manually afterward.
  const selfLoopEdges = validEdges.filter((e) => e.source === e.target);
  const interNodeEdges = validEdges.filter((e) => e.source !== e.target);

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
      'elk.spacing.nodeNode': '80',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
      'elk.spacing.edgeEdge': '25',
      'elk.spacing.edgeNode': '30',
      'elk.layered.spacing.edgeNodeBetweenLayers': '30',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '25',
      'elk.spacing.edgeLabel': '12',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED'
    },
    children: nodes.map((node) => ({
      ...node,
      width: nodeWidth,
      height: nodeHeight,
    })),
    edges: interNodeEdges.map((edge) => {
      const labelSize = estimateLabelSize(edge.data?.rawLabel);
      return {
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
        labels: edge.data?.rawLabel
          ? [{ text: edge.data.rawLabel, width: labelSize.width, height: labelSize.height }]
          : [],
      };
    }),
  };

  try {
    const layoutedGraph = await elk.layout(graph);

    const layoutedNodes = nodes.map((node) => {
      const layoutedNode = layoutedGraph.children.find((lgNode) => lgNode.id === node.id);
      return {
        ...node,
        targetPosition: 'top',
        sourcePosition: 'bottom',
        position: {
          x: layoutedNode.x,
          y: layoutedNode.y,
        },
      };
    });
    const layoutedNodesById = {};
    layoutedNodes.forEach((n) => { layoutedNodesById[n.id] = n; });

    // Pull each edge's ELK-computed route (and label position) back out
    const elkEdgesById = {};
    (layoutedGraph.edges || []).forEach((e) => { elkEdgesById[e.id] = e; });

    const layoutedInterNodeEdges = interNodeEdges.map((edge) => {
      const elkEdge = elkEdgesById[edge.id];
      const section = elkEdge?.sections?.[0];
      const points = section
        ? [section.startPoint, ...(section.bendPoints || []), section.endPoint]
        : [];
      const elkLabel = elkEdge?.labels?.[0];

      return {
        ...edge,
        type: 'elkEdge',
        data: {
          ...edge.data,
          points,
          labelX: elkLabel ? elkLabel.x + elkLabel.width / 2 : undefined,
          labelY: elkLabel ? elkLabel.y + elkLabel.height / 2 : undefined,
        },
      };
    });

    // Manually route self-loops off the laid-out node position; stagger
    // multiple loops on the same node so they don't sit on top of each other.
    const loopIndexByNode = {};
    const layoutedSelfLoops = selfLoopEdges.map((edge) => {
      const node = layoutedNodesById[edge.source];
      const index = loopIndexByNode[edge.source] || 0;
      loopIndexByNode[edge.source] = index + 1;
      const points = node ? buildSelfLoopPoints(node, index) : [];
      const labelSize = estimateLabelSize(edge.data?.rawLabel);

      return {
        ...edge,
        type: 'elkEdge',
        data: {
          ...edge.data,
          points,
          labelX: points.length ? points[1].x + labelSize.width / 2 + 10 : undefined,
          labelY: points.length ? (points[1].y + points[2].y) / 2 : undefined,
        },
      };
    });

    return { nodes: layoutedNodes, edges: [...layoutedInterNodeEdges, ...layoutedSelfLoops] };
  } catch (error) {
    console.error("ELK Layout Error:", error);
    // Degrade gracefully: fall back to React Flow's default edge routing
    // (no ELK positions to key off of), but keep labels visible rather
    // than relying on the elkEdge type, which needs data.points to render.
    return {
      nodes,
      edges: validEdges.map((edge) => ({ ...edge, label: edge.data?.label })),
    };
  }
};

function FlowCanvas({ layoutedNodes, layoutedEdges, nodeTypes, edgeTypes }) {
  const { fitView } = useReactFlow();

  // Automatically center and zoom to fit whenever nodes change
  useEffect(() => {
    if (layoutedNodes.length > 0) {
      setTimeout(() => {
        fitView({ padding: 0.3, duration: 400 });
      }, 50);
    }
  }, [layoutedNodes, fitView]);

  return (
    <ReactFlow
      nodes={layoutedNodes}
      edges={layoutedEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.5 }}
    >
      <Background variant="dots" gap={16} size={1} color="#cbd5e1" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}


export default function InteractionFlowchart({ data, onEditNode, onLabelChange }) {
  const [layoutedNodes, setLayoutedNodes] = useState([]);
  const [layoutedEdges, setLayoutedEdges] = useState([]);

  const onEditNodeRef = useRef(onEditNode);
  const onLabelChangeRef = useRef(onLabelChange);

  useEffect(() => { onEditNodeRef.current = onEditNode; }, [onEditNode]);
  useEffect(() => { onLabelChangeRef.current = onLabelChange; }, [onLabelChange]);

  useEffect(() => {
    if (!data || !data.nodes || data.nodes.length === 0) return;

    // Format the data for React Flow
    const formatEdgeLabel = (text) => {
      if (!text) return '';
      const words = text.split(' ');
      let wrappedText = '';
      let lineLength = 0;

      for (const word of words) {
        // Wraps roughly every 10 characters so the box stays compact
        if (lineLength + word.length > 10) {
          wrappedText += '\n' + word;
          lineLength = word.length;
        } else {
          wrappedText += (wrappedText ? ' ' : '') + word;
          lineLength += word.length + 1;
        }
      }
      return wrappedText;
    };

    const formattedNodes = data.nodes.map((node, index) => {
      const nodeId = node.id ? node.id.toString() : `fallback-node-${index}`;

      return {
        id: nodeId,
        type: 'editableNode',
        data: {
          label: node.label,
          detailedPrompt: node.detailedPrompt || "No detailed prompt generated.",
          onOpenPrompt: () => onEditNodeRef.current && onEditNodeRef.current(nodeId),
          onLabelChange: (newText) => onLabelChangeRef.current && onLabelChangeRef.current(nodeId, newText)
        },
        position: { x: 0, y: 0 },
      };
    });

    const safeEdges = Array.isArray(data.edges) ? data.edges : [];
    const formattedEdges = safeEdges.map((edge, index) => {
      const safeFrom = edge.from ? String(edge.from) : `unknown-source-${index}`;
      const safeTo = edge.to ? String(edge.to) : `unknown-target-${index}`;
      const wrappedLabel = formatEdgeLabel(edge.label);

      return {
        id: `e-${safeFrom}-${safeTo}-${index}`,
        source: safeFrom,
        target: safeTo,
        animated: true,
        style: { stroke: '#10b981', strokeWidth: 2 },
        data: {
          label: wrappedLabel,
          rawLabel: wrappedLabel,
        },

        // This adds the directional arrow pointing to the target
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 20,
          height: 20,
          color: '#10b981', // Matches your line color
        },
      };
    });

    // 2. Run it through the ELK layout engine
    getLayoutedElements(formattedNodes, formattedEdges).then(({ nodes, edges }) => {
      setLayoutedNodes(nodes);
      setLayoutedEdges(edges);
    });

  }, [data]);

  if (!data || !data.nodes || data.nodes.length === 0) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#666' }}>No flowchart available. Start speaking to generate a diagram!</p>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', minHeight: '500px', background: '#f8fafc', borderRadius: '12px' }}>
      <ReactFlowProvider>
        <FlowCanvas
        layoutedNodes={layoutedNodes}
        layoutedEdges={layoutedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
      />
      </ReactFlowProvider>
    </div>
  );
}
