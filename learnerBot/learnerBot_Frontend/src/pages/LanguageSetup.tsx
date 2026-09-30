import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import LanguagePicker from '../components/LanguagePicker';

// The single place to set which language(s) Speech-to-Text listens for across
// the app shown automatically right after a username's first-ever login
// (see Login.tsx), and reachable anytime after via the floating 🌐 button
// (see App.tsx). Saved as a sticky per-username override in localStorage
// (sttLanguagesOverride_<username>), read by Design.tsx/CreateProfile.tsx.
export default function LanguageSetup() {
  const navigate = useNavigate();
  const location = useLocation();
  // Reopened via the 🌐 button (from any page) returns you there — including that
  // page's own location.state, since Testing/Deploy need it to render at all and
  // would otherwise bounce you away as if the state were simply missing. The
  // mandatory first-login flow (Login.tsx) has no prior in-app page, so falls
  // back to /profiles with no state to restore.
  const navState = location.state as { returnTo?: string; returnState?: any } | null;
  const returnTo = navState?.returnTo || '/profiles';
  const returnState = navState?.returnState;
  const currentUser = localStorage.getItem("currentUser") || "Guest";
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(`sttLanguagesOverride_${currentUser}`);
      const parsed = saved ? JSON.parse(saved) : null;
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : ['en-US'];
    } catch {
      return ['en-US'];
    }
  });

  const handleContinue = () => {
    localStorage.setItem(`sttLanguagesOverride_${currentUser}`, JSON.stringify(selectedLanguages));
    navigate(returnTo, { state: returnState });
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200 w-full max-w-lg flex flex-col gap-6">
        <div className="text-center">
          <span className="text-4xl block mb-3">🌐</span>
          <h1 className="text-2xl font-bold text-slate-800">Choose Your Language</h1>
          <p className="text-sm text-slate-500 mt-2">
            Pick what the app should listen for when you speak. Select a maximum of 2 if you'll be mixing languages in the same conversation.
          </p>
        </div>

        <LanguagePicker selected={selectedLanguages} onChange={setSelectedLanguages} />

        <p className="text-xs text-slate-400 text-center">
          This sticks to your username — reopen this page anytime from the 🌐 button.
        </p>

        <button
          onClick={handleContinue}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl shadow-md transition-all"
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
