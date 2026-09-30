import { useNavigate, useLocation } from 'react-router-dom';

// Reopens the LanguageSetup page anytime — the single place to change which
// language(s) STT listens for, stacked above the Settings gear and Help button.
export default function LanguageButton() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <button
      onClick={() => navigate('/language-setup', { state: { returnTo: location.pathname, returnState: location.state } })}
      title="Language Settings"
      className="fixed bottom-[168px] right-6 z-40 w-12 h-12 rounded-full bg-blue-800 hover:bg-blue-900 text-white text-xl shadow-lg flex items-center justify-center transition-all hover:scale-105 active:scale-95"
    >
      🌐
    </button>
  );
}
