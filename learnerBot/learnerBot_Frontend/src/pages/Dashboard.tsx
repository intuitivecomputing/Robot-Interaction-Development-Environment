import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Dashboard() {
  const navigate = useNavigate();
  const [backendStatus, setBackendStatus] = useState<'checking' | 'online' | 'offline'>('checking');

  // Automatically ping the backend when the dashboard loads
  useEffect(() => {
    const apiBase = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000/api';
    let cleanBase = apiBase.replace(/\/+$/, '');
    if (cleanBase.endsWith('/api')) {
      cleanBase = cleanBase.slice(0, -4);
    }
    const healthUrl = `${cleanBase}/api/health`;

    fetch(healthUrl)
      .then((res) => {
        if (res.ok) {
          setBackendStatus('online');
        } else {
          setBackendStatus('offline');
        }
      })
      .catch(() => {
        setBackendStatus('offline');
      });
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <header className="mb-12 text-center flex flex-col items-center">
        <h1 className="text-4xl font-extrabold text-indigo-600 tracking-tight mb-2">Bot Generator Hub</h1>
        <p className="text-slate-500 text-lg mb-4">Get started in creating and customizing your very own activities for your robot. Create robot instructions from scratch in the 'Design Prompts' page or recreate your old instructions using the 'Inject Context' and 'Deploy to Robot' pages.</p>
        
        {/* Live Backend Connection Badge */}
        <div className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-2 ${
          backendStatus === 'online' ? 'bg-emerald-100 text-emerald-700' : 
          backendStatus === 'offline' ? 'bg-red-100 text-red-700' : 
          'bg-slate-100 text-slate-500'
        }`}>
          <span className={`w-2 h-2 rounded-full ${
            backendStatus === 'online' ? 'bg-emerald-500 animate-pulse' : 
            backendStatus === 'offline' ? 'bg-red-500' : 
            'bg-slate-400'
          }`}></span>
          Backend: {backendStatus}
        </div>
      </header>

      {/* Navigation Cards Grid (Updated to a 2x2 Grid for the 4 steps) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Design Page Button (Step 1) */}
        <button 
          onClick={() => navigate('/design')}
          className="bg-white border border-slate-200 p-6 rounded-2xl shadow-sm hover:shadow-md transition-all text-left group hover:border-indigo-500"
        >
          <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center font-bold text-xl mb-4 group-hover:bg-indigo-600 group-hover:text-white transition-all">
            🎙️
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">1. Design Instruction Flow</h2>
          <p className="text-sm text-slate-500">Use voice commands and AI to create and refine customized interaction rules for your robot.</p>
        </button>

        {/* NEW: Content/Context Page Button (Step 2) */}
        <button 
          onClick={() => navigate('/content')}
          className="bg-white border border-slate-200 p-6 rounded-2xl shadow-sm hover:shadow-md transition-all text-left group hover:border-blue-500"
        >
          <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center font-bold text-xl mb-4 group-hover:bg-blue-600 group-hover:text-white transition-all">
            🧩
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">2. Add Context</h2>
          <p className="text-sm text-slate-500">Define ... knowledge directly into your AI-generated flowcharts.</p>
        </button>

        {/* Testing Page Button (Step 3) */}
        <button 
          onClick={() => navigate('/testing')}
          className="bg-white border border-slate-200 p-6 rounded-2xl shadow-sm hover:shadow-md transition-all text-left group hover:border-amber-500"
        >
          <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center font-bold text-xl mb-4 group-hover:bg-amber-600 group-hover:text-white transition-all">
            🧪
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">3. Test What You Have</h2>
          <p className="text-sm text-slate-500">Get a sneak of what the conversation with the robot can look like to make sure it behaves correctly before you send it to the robot.</p>
        </button>

        {/* Deploy Page Button (Step 4) */}
        <button 
          onClick={() => navigate('/library')}
          className="bg-white border border-slate-200 p-6 rounded-2xl shadow-sm hover:shadow-md transition-all text-left group hover:border-emerald-500"
        >
          <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center font-bold text-xl mb-4 group-hover:bg-emerald-600 group-hover:text-white transition-all">
            🚀
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">4. Send to Robot</h2>
          <p className="text-sm text-slate-500">Push your finalized prompts wirelessly to your social learning robot hardware.</p>
        </button>

      </div>
    </div>
  );
}