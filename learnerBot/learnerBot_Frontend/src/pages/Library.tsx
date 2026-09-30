import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildHardwareFlowchart, fetchRobotSettings, buildSettingsBlock, FACIAL_EXPRESSION_OPTIONS, GESTURE_OPTIONS } from '../utils/deploymentPrompt';

export default function Library() {
  const navigate = useNavigate();
  const [activities, setActivities] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedActivity, setSelectedActivity] = useState<any | null>(null);

  // Menu dropdown state
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Edit Modal State
  const [editingActivity, setEditingActivity] = useState<any | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editNodes, setEditNodes] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isRedeploying, setIsRedeploying] = useState(false);
  const [showRedeploySuccess, setShowRedeploySuccess] = useState(false);
  // Whichever library entry robot_configs/activity-1 was last built from —
  // that's the one currently running on the robot.
  const [deployedActivityId, setDeployedActivityId] = useState<string | null>(null);
  const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');

  const currentUser = localStorage.getItem("currentUser") || "user1";
  const activeRobot = localStorage.getItem("activeRobot") || "whiteBot";
  const activeLearner = JSON.parse(localStorage.getItem("activeLearner") || '{}');
  const profileId = activeLearner.id || "unknown";
  // Close dropdown if clicking outside
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 1. FETCH FROM PYTHON API
  useEffect(() => {
    const fetchActivities = async () => {
      try {
        const response = await fetch(`${apiBase}/api/library/${activeRobot}/${currentUser}/${profileId}`);
        if (response.ok) {
          const data = await response.json();
          setActivities(data.activities || []);
        }
      } catch (error) {
        console.error("Error fetching library:", error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchActivities();
  }, [apiBase, activeRobot, currentUser, profileId]);

  // 1b. Which activity is currently deployed to the robot
  useEffect(() => {
    const fetchRobotConfig = async () => {
      try {
        const response = await fetch(`${apiBase}/api/robot-config/${activeRobot}`);
        if (response.ok) {
          const data = await response.json();
          setDeployedActivityId(data.libraryId || null);
        }
      } catch (error) {
        console.error("Error fetching robot config:", error);
      }
    };
    fetchRobotConfig();
  }, [apiBase, activeRobot]);

  // 2. DELETE VIA PYTHON API
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(null);
    if (!window.confirm("Are you sure you want to delete this activity?")) return;
    
    try {
      const response = await fetch(`${apiBase}/api/library/${activeRobot}/${currentUser}/${profileId}/${id}`, { method: 'DELETE' });
      if (response.ok) {
        setActivities(activities.filter(a => a.id !== id));
        setSelectedActivity((prev: any) => (prev?.id === id ? null : prev));
      } else {
        alert("Failed to delete activity on server.");
      }
    } catch (error) {
      console.error("Error deleting activity:", error);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm("Are you sure you want to delete all activities in the Activity Center? This cannot be undone.")) return;

    try {
      const response = await fetch(`${apiBase}/api/library/${activeRobot}/${currentUser}/${profileId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error("Failed to clear activity center");

      setActivities([]);
      setSelectedActivity(null);
    } catch (error) {
      console.error("Error clearing activity center:", error);
      alert("Could not clear activities. Please try again.");
    }
  };

  // 3. EDIT VIA PYTHON API
  const handleSaveEdit = async () => {
    if (!editingActivity) return;
    setIsSaving(true);

    try {
      const response = await fetch(`${apiBase}/api/library/${activeRobot}/${currentUser}/${profileId}/${editingActivity.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle,
          systemPrompt: editPrompt,
          nodes: editNodes, 
          timestamp: new Date().toISOString(),
          deploy_to_robot: false
        })
      });

      if (response.ok) {
        setActivities(activities.map(a => {
          if (a.id === editingActivity.id) {
            // Instantly update the React UI with the new node data
            const updatedFlowchart = { ...(a.raw_flowchart || a.flowchart), nodes: editNodes };
            return { 
              ...a, 
              title: editTitle, 
              systemPrompt: editPrompt, 
              raw_flowchart: updatedFlowchart 
            };
          }
          return a;
        }));
        setEditingActivity(null);
      } else {
        alert("Failed to save changes to server.");
      }
    } catch (error) {
      console.error("Error updating activity:", error);
    } finally {
      setIsSaving(false);
    }
  };

  // 4. REDEPLOY: Send the selected activity straight to the robot, no detour through /deploy.
  const handleRedeploy = async () => {
    if (!selectedActivity || selectedActivity.id === deployedActivityId) return;

    setIsRedeploying(true);
    try {
      const flowchart = selectedActivity.raw_flowchart || selectedActivity.flowchart;
      const robotSettings = await fetchRobotSettings(apiBase, activeRobot, currentUser);
      const settingsBlock = buildSettingsBlock(robotSettings);
      const allowedExpressions = Array.isArray(robotSettings?.facialExpressions) && robotSettings.facialExpressions.length > 0
        ? robotSettings.facialExpressions
        : FACIAL_EXPRESSION_OPTIONS;
      const allowedGestures = Array.isArray(robotSettings?.gestures) && robotSettings.gestures.length > 0
        ? robotSettings.gestures
        : GESTURE_OPTIONS;
      const allowedLanguages = Array.isArray(robotSettings?.languages) && robotSettings.languages.length > 0
        ? robotSettings.languages
        : ['en-US'];
      const hardwareFlowchart = buildHardwareFlowchart(flowchart, allowedExpressions, allowedGestures, allowedLanguages);
      // Settings appended fresh here only — selectedActivity.systemPrompt stays
      // clean going back into the library so it doesn't compound next time.
      const hardwareSystemPrompt = `${selectedActivity.systemPrompt || ''}${settingsBlock}`;

      const response = await fetch(`${apiBase}/api/library/${activeRobot}/${currentUser}/${profileId}/${selectedActivity.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: selectedActivity.title,
          libraryFlowchart: flowchart,
          hardwareFlowchart,
          systemPrompt: selectedActivity.systemPrompt,
          hardwareSystemPrompt,
          timestamp: new Date().toISOString(),
          deploy_to_robot: true
        })
      });

      if (!response.ok) throw new Error("Failed to redeploy activity");

      setDeployedActivityId(selectedActivity.id);
      setShowRedeploySuccess(true);
      setTimeout(() => setShowRedeploySuccess(false), 2500);
    } catch (error) {
      console.error("Error redeploying activity:", error);
      alert("Could not send activity to the robot. Please try again.");
    } finally {
      setIsRedeploying(false);
    }
  };

  const openEditModal = (activity: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(null);
    setEditingActivity(activity);
    setEditTitle(activity.title || '');
    setEditPrompt(activity.systemPrompt || '');

    // Grab the nodes and safely force them into an Array
    const rawNodes = activity.raw_flowchart?.nodes || activity.flowchart?.nodes || [];
    const nodesArray = Array.isArray(rawNodes) ? rawNodes : Object.values(rawNodes);
    
    // Normalize and copy into state
    const normalizedNodes = nodesArray.map((node: any) => ({
      ...node,
      detailedPrompt: node.data?.detailedPrompt || node.detailedPrompt || '',
      label: node.data?.label || node.label || `Node ${node.id}`
    }));
    
    setEditNodes(JSON.parse(JSON.stringify(normalizedNodes)));
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500 font-medium animate-pulse">Loading Deployed Library...</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col gap-8">
      
      {/* Header */}
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-5">
        <div className="flex justify-end">
          <span className="text-xs font-semibold bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full uppercase tracking-wider">
            Phase 4: Send to Robot
          </span>
        </div>
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Activity Center</h1>
            <p className="text-sm text-slate-500 mt-1">Select an activity to send to the robot, or use the menu to edit/delete.</p>
          </div>
          <div className="flex items-center gap-4">
            {activities.length > 0 && (
              <button onClick={handleClearAll} className="text-xs font-semibold text-red-500 hover:underline">
                Clear All
              </button>
            )}
            <button
              onClick={() => navigate('/design')}
              className="text-sm font-semibold text-slate-600 hover:text-slate-900 bg-white border border-slate-200 px-4 py-2 rounded-xl shadow-sm transition-all"
            >
              ← Back to Activity Designs
            </button>
          </div>
        </div>
      </div>

      {/* Gallery Grid */}
      {activities.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-16 text-center shadow-sm">
          <span className="text-5xl mb-4 block">🚀</span>
          <h3 className="text-lg font-bold text-slate-700">No sent activities found</h3>
          <p className="text-slate-500 text-sm mt-2">Complete the design and testing phases to send your first activity.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {activities.map((activity) => {
            const isSelected = selectedActivity?.id === activity.id;
            const isDeployed = deployedActivityId === activity.id;

            return (
            <div
              key={activity.id}
              onClick={() => setSelectedActivity(activity)}
              className={`bg-white p-6 rounded-2xl shadow-sm flex flex-col justify-between h-64 relative transition-all cursor-pointer group border-2 ${
                isSelected
                  ? 'border-emerald-600 shadow-md ring-4 ring-emerald-50'
                  : 'border-slate-200 hover:border-emerald-400 hover:shadow-md'
              }`}
            >
              {isDeployed && (
                <div className="absolute -top-3 left-4 bg-emerald-600 text-white text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded-full shadow-sm flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-white rounded-full"></span>
                  Currently On Robot
                </div>
              )}

              {/* Top Row: Icon + Title + Selected Badge + Three-Dots Menu */}
              <div>
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl p-2 bg-emerald-50 rounded-xl border border-emerald-100 flex items-center justify-center shrink-0">🚀</span>
                    <h3 className="font-bold text-slate-800 text-base leading-snug line-clamp-2 group-hover:text-emerald-600 transition-colors">
                      {activity.title || 'Untitled Activity'}
                    </h3>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {isSelected && (
                      <div className="bg-emerald-600 text-white rounded-full p-1">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      </div>
                    )}

                    {/* Three Dots Button */}
                    <div className="relative" ref={openMenuId === activity.id ? menuRef : null}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuId(openMenuId === activity.id ? null : activity.id);
                        }}
                        className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors font-bold text-lg leading-none"
                      >
                        ⋮
                      </button>

                      {/* Dropdown Menu */}
                      {openMenuId === activity.id && (
                        <div className="absolute right-0 mt-1 w-36 bg-white border border-slate-200 rounded-xl shadow-lg py-1.5 z-20 flex flex-col">
                          <button
                            onClick={(e) => openEditModal(activity, e)}
                            className="w-full text-left px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
                          >
                            Edit Details
                          </button>
                          <button
                            onClick={(e) => handleDelete(activity.id, e)}
                            className="w-full text-left px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 transition-colors"
                          >
                            Delete Activity
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Middle: Prompt Preview Snippet */}
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-100 my-3 flex-grow overflow-hidden">
                <p className="text-xs text-slate-500 font-mono line-clamp-3 leading-relaxed">
                  {activity.systemPrompt || 'No system prompt recorded.'}
                </p>
              </div>

              {/* Footer: Action hint */}
              <div className="flex justify-between items-center text-xs text-slate-400 border-t border-slate-100 pt-3">
                <span>{isSelected ? 'Selected' : 'Click card to select'}</span>
                {isSelected && <span className="font-semibold text-emerald-600">✓</span>}
              </div>

            </div>
            );
          })}
        </div>
      )}

      {/* The Redeploy Button */}
      {activities.length > 0 && (
        <div className="flex justify-end border-t border-slate-200 pt-6">
          <button
            onClick={handleRedeploy}
            disabled={!selectedActivity || isRedeploying || selectedActivity.id === deployedActivityId}
            className={`px-8 py-4 rounded-xl font-bold shadow-md transition-all text-lg ${
              selectedActivity && !isRedeploying && selectedActivity.id !== deployedActivityId
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white transform hover:-translate-y-1'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            {isRedeploying ? 'Sending...' : selectedActivity?.id === deployedActivityId ? 'Already On Robot' : 'Send to Robot →'}
          </button>
        </div>
      )}

      {/* Redeploy Success Toast */}
      {showRedeploySuccess && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="bg-slate-900 text-white px-8 py-6 rounded-2xl shadow-2xl flex items-center gap-4">
            <div className="bg-emerald-500 text-white rounded-full p-2 shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <span className="text-lg font-semibold">Activity sent to the robot!</span>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingActivity && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
              <h3 className="font-bold text-lg text-slate-800">Edit Deployed Activity</h3>
              <button onClick={() => setEditingActivity(null)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">×</button>
            </div>

            <div className="p-6 flex flex-col gap-4 overflow-y-auto scrollbar-thin">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Activity Title</label>
                <input 
                  type="text" 
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all"
                />
              </div>
              
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">System Prompt</label>
                <textarea 
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  className="w-full h-64 bg-slate-50 border border-slate-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 p-4 rounded-xl text-sm text-slate-700 font-mono leading-relaxed outline-none transition-all resize-none shadow-inner scrollbar-thin"
                />
              </div>

              {/* --- STATE PROMPTS SECTION --- */}
              {editNodes && editNodes.length > 0 && (
                <div className="border-t border-slate-200 pt-6 mt-2">
                  <div className="mb-4">
                    <h4 className="text-base font-bold text-slate-800 flex items-center gap-2">
                    Individual State Prompts
                    </h4>
                    <p className="text-sm text-slate-500">Edit the specific instructions applied to each node.</p>
                  </div>
                  
                  <div className="flex flex-col gap-6">
                    {editNodes.map((node: any, index: number) => (
                      <div key={node.id} className="bg-slate-50 border border-slate-200 rounded-xl p-5">
                        <label className="block text-xs font-extrabold text-emerald-600 mb-3 uppercase tracking-wider flex justify-between items-center">
                          <span>State: {node.label}</span>
                          <span className="text-slate-400 text-[10px] font-mono">{node.id}</span>
                        </label>
                        <textarea 
                          value={node.detailedPrompt || ''}
                          onChange={(e) => {
                            const newNodes = [...editNodes];
                            newNodes[index].detailedPrompt = e.target.value;
                            if (newNodes[index].data) {
                              newNodes[index].data.detailedPrompt = e.target.value;
                            }
                            setEditNodes(newNodes);
                          }}
                          className="w-full h-48 bg-white border border-slate-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 p-4 rounded-lg text-xs text-slate-700 font-mono leading-relaxed outline-none transition-all resize-y shadow-inner"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* --------------------------------- */}
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3 shrink-0">
              <button 
                onClick={() => setEditingActivity(null)} 
                className="px-4 py-2 rounded-xl font-semibold text-slate-600 hover:bg-slate-200 transition-colors text-sm"
                disabled={isSaving}
              >
                Cancel
              </button>
              <button 
                onClick={handleSaveEdit} 
                disabled={isSaving}
                className="px-6 py-2 rounded-xl font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow transition-all text-sm disabled:bg-emerald-400"
              >
                {isSaving ? 'Saving Changes...' : 'Save Changes'}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}