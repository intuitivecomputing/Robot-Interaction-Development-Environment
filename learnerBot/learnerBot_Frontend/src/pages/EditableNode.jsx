import React from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function EditableNode({ id, data, isConnectable }) {
  const { updateNodeData } = useReactFlow();

  const handleChange = (evt) => {
    updateNodeData(id, { label: evt.target.value });
  };

  const handleBlur = (evt) => {
    if (data.onLabelChange) {
      data.onLabelChange(evt.target.value);
    }
  };

  return (
    <div 
      className="relative"
      style={{
        background: '#fff',
        border: '2px solid #10b981',
        borderRadius: '8px',
        padding: '8px',
        width: '220px',
        height: '80px',
        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <button
        onClick={() => data.onOpenPrompt && data.onOpenPrompt(id)}
        className="absolute -top-3 -right-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full w-7 h-7 flex items-center justify-center shadow-md cursor-pointer border-2 border-white transition-transform hover:scale-110 z-10"
        title="Edit Node Sub-Prompt"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>

      <Handle type="target" position={Position.Top} className="w-3 h-3 bg-emerald-500 border-2 border-white" isConnectable={isConnectable} />
      
      <textarea
        value={data.label}
        onChange={handleChange}
        onBlur={handleBlur}
        className="nodrag" 
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          resize: 'none',
          outline: 'none',
          textAlign: 'center',
          fontWeight: '600',
          color: '#333',
          background: 'transparent',
          fontSize: '12px',
        }}
      />

      <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-emerald-500 border-2 border-white" isConnectable={isConnectable} />
    </div>
  );
}