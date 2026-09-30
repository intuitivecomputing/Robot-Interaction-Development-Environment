import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export default function UserProfiles() {
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<any[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(true);


  const currentUser = localStorage.getItem("currentUser") || "user1";
  const activeRobot = localStorage.getItem("activeRobot") || "whiteBot";

  // Card Menu / Edit State
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [editingProfile, setEditingProfile] = useState<any | null>(null);
  const [editName, setEditName] = useState('');
  const [editTargetAge, setEditTargetAge] = useState('');
  const [editCognitiveProfile, setEditCognitiveProfile] = useState('');
  const [editInterests, setEditInterests] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    // Load the profiles for this specific user
    const fetchProfiles = async () => {
      try {
        // Look at this user's profile folder for this specific robot, via the backend
        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        const url = `${apiBase}/api/profiles/${activeRobot}/${currentUser}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error("Failed to fetch");

        const data = await response.json();
        setProfiles(data.profiles || []);
      } catch (error) {
        console.error("Error fetching profiles from Firebase:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchProfiles();
  }, [activeRobot, currentUser]);


  const handleNext = () => {
    if (!selectedProfile) return;
    localStorage.setItem("activeLearner", JSON.stringify(selectedProfile));
    navigate('/design');
  };

  const handleDeleteIndividual = async (profileId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(null);
    if (!window.confirm("Are you sure you want to delete this profile?")) return;

    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/profiles/${activeRobot}/${currentUser}/${profileId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete profile");

      setProfiles((prev) => prev.filter((p) => p.id !== profileId));
      setSelectedProfile((prev: any) => (prev?.id === profileId ? null : prev));
    } catch (error) {
      console.error("Error deleting profile:", error);
      alert("Could not delete profile. Please try again.");
    }
  };

  const openEditProfileModal = (profile: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(null);
    setEditingProfile(profile);
    setEditName(profile.name || '');
    setEditTargetAge(profile.targetAge || '');
    setEditCognitiveProfile(profile.cognitiveProfile || '');
    setEditInterests(profile.interests || '');
  };

  const handleSaveProfileEdit = async () => {
    if (!editingProfile) return;
    if (!editName.trim()) return alert("Please provide a name!");

    setIsSavingEdit(true);
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/profiles/${activeRobot}/${currentUser}/${editingProfile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editName,
          targetAge: editTargetAge,
          cognitiveProfile: editCognitiveProfile,
          interests: editInterests
        })
      });

      if (!response.ok) throw new Error("Failed to save changes");

      const updated = { ...editingProfile, name: editName, targetAge: editTargetAge, cognitiveProfile: editCognitiveProfile, interests: editInterests };
      setProfiles((prev) => prev.map((p) => (p.id === editingProfile.id ? updated : p)));
      setSelectedProfile((prev: any) => (prev?.id === editingProfile.id ? updated : prev));
      setEditingProfile(null);
    } catch (error) {
      console.error("Error updating profile:", error);
      alert("Could not save changes. Please try again.");
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm("Are you sure you want to delete all profiles? This cannot be undone.")) return;

    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/profiles/${activeRobot}/${currentUser}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to clear profiles");

      setProfiles([]);
      setSelectedProfile(null);
    } catch (error) {
      console.error("Error clearing profiles:", error);
      alert("Could not clear profiles. Please try again.");
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-12">
      <div className="flex justify-end mb-4">
        <span className="text-xs font-semibold bg-rose-100 text-rose-800 px-3 py-1 rounded-full uppercase tracking-wider">Phase 1: User Profile Setup</span>
      </div>
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 mb-2">Who is Talking to the Robot?</h1>
          <p className="text-slate-500">Provide details on the target user that will be interacting with the robot. Choose an existing profile or create a new one.</p>
        </div>
        <div className="flex items-center gap-4">
          {profiles.length > 0 && (
            <button onClick={handleClearAll} className="text-xs font-semibold text-red-500 hover:underline">
              Clear All
            </button>
          )}
          <button
            onClick={() => {
              localStorage.removeItem("currentUser");
              localStorage.removeItem("activeLearner");
              navigate('/login');
            }}
            className="text-sm font-semibold text-slate-400 hover:text-indigo-600 transition-colors"
          >
            ← Back to Login
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center items-center min-h-[200px]">
          <p className="text-slate-400 font-medium animate-pulse">Loading profiles from cloud...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* The "+" Card */}
          <div 
            onClick={() => navigate('/createProfile')}
            className="bg-indigo-50 border-2 border-dashed border-indigo-200 hover:border-indigo-400 hover:bg-indigo-100 p-6 rounded-2xl flex flex-col items-center justify-center text-center cursor-pointer transition-all min-h-[200px] group"
          >
            <div className="w-12 h-12 bg-indigo-200 text-indigo-700 rounded-full flex items-center justify-center text-2xl font-bold mb-4 group-hover:scale-110 transition-transform">
              +
            </div>
            <h3 className="font-bold text-indigo-900">New User</h3>
            <p className="text-xs text-indigo-600 mt-1">Create a new profile</p>
          </div>

          {/* Existing Profile Cards */}
          {profiles.map((profile) => {
            const isSelected = selectedProfile?.id === profile.id;
            
            return (
              <div
                key={profile.id}
                onClick={() => setSelectedProfile(profile)}
                className={`bg-white p-6 rounded-2xl cursor-pointer transition-all min-h-[200px] flex flex-col border-2 relative ${
                  isSelected
                    ? 'border-indigo-600 shadow-md ring-4 ring-indigo-50'
                    : 'border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-300'
                }`}
              >
                {/* --- CARD MENU --- */}
                <div className="absolute top-4 right-4 z-10" ref={openMenuId === profile.id ? menuRef : null}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(openMenuId === profile.id ? null : profile.id);
                    }}
                    className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors font-bold text-lg leading-none"
                  >
                    ⋮
                  </button>

                  {openMenuId === profile.id && (
                    <div className="absolute right-0 mt-1 w-36 bg-white border border-slate-200 rounded-xl shadow-lg py-1.5 z-20 flex flex-col">
                      <button
                        onClick={(e) => openEditProfileModal(profile, e)}
                        className="w-full text-left px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        Edit Details
                      </button>
                      <button
                        onClick={(e) => handleDeleteIndividual(profile.id, e)}
                        className="w-full text-left px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 transition-colors"
                      >
                        Delete Profile
                      </button>
                    </div>
                  )}
                </div>
                {/* ------------------------- */}

                <div className="flex justify-between items-start mb-4">
                  <div className="text-4xl">👤</div>
                  {isSelected && (
                    <div className="absolute top-14 right-4 bg-indigo-600 text-white rounded-full p-1">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </div>
                  )}
                </div>
                <h3 className="font-bold text-xl text-slate-800 pr-8">{profile.name || "Unnamed"}</h3>
                <p className="text-sm text-slate-500 mt-1 mb-4 flex-1">
                  {profile.targetAge ? `Age: ${profile.targetAge}` : 'Age not specified'}
                </p>

                <div className="flex gap-2 flex-wrap">
                  {profile.interests && (
                    <span className="text-xs font-semibold bg-blue-50 text-blue-700 px-3 py-1 rounded-full w-fit truncate max-w-full">
                      {profile.interests}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* The Next Button */}
      <div className="mt-12 flex justify-end border-t border-slate-200 pt-6">
        <button 
          onClick={handleNext}
          disabled={!selectedProfile}
          className={`px-8 py-4 rounded-xl font-bold shadow-md transition-all text-lg ${
            selectedProfile 
              ? 'bg-indigo-600 hover:bg-indigo-700 text-white transform hover:-translate-y-1' 
              : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          }`}
        >
          Continue to Activity Design →
        </button>
      </div>

      {/* Edit Profile Modal */}
      {editingProfile && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
              <h3 className="font-bold text-lg text-slate-800">Edit Profile</h3>
              <button onClick={() => setEditingProfile(null)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">×</button>
            </div>

            <div className="p-6 flex flex-col gap-4 overflow-y-auto scrollbar-thin">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Name / Alias</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Target Age / Grade</label>
                <input
                  type="text"
                  value={editTargetAge}
                  onChange={(e) => setEditTargetAge(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Cognitive & Skill Profile</label>
                <textarea
                  value={editCognitiveProfile}
                  onChange={(e) => setEditCognitiveProfile(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all resize-none min-h-[70px]"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Special Interests</label>
                <textarea
                  value={editInterests}
                  onChange={(e) => setEditInterests(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all resize-none min-h-[70px]"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3 shrink-0">
              <button
                onClick={() => setEditingProfile(null)}
                className="px-4 py-2 rounded-lg font-semibold text-slate-600 hover:bg-slate-200 transition-colors"
                disabled={isSavingEdit}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveProfileEdit}
                disabled={isSavingEdit}
                className="px-6 py-2 rounded-lg font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow transition-all disabled:opacity-50"
              >
                {isSavingEdit ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}