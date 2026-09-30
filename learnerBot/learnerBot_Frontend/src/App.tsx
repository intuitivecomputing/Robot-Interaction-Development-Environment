import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login'
import LanguageSetup from './pages/LanguageSetup'
import Profiles from './pages/UserProfiles'
import CreateProfile from './pages/CreateProfile'
import Dashboard from './pages/Dashboard';
import Design from './pages/Design';
import Testing from './pages/Testing';
import Deploy from './pages/Deploy';
import Content from './pages/Content';
import Library from './pages/Library';
import HelpButton from './components/HelpButton';
import SettingsSidebar from './components/SettingsSidebar';
import LanguageButton from './components/LanguageButton';

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-slate-50 text-slate-800 font-sans">
        <Routes>
          {/* Default to Dashboard — preserve any query string (e.g. ?robot=blueBot) on redirect */}
          <Route path="/" element={<Navigate to={`/login${window.location.search}`} replace />} />
          
          {/* App Pages */}
          <Route path="/login" element={<Login />} />
          <Route path="/language-setup" element={<LanguageSetup />} />
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/createProfile" element={<CreateProfile />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/design" element={<Design />} />
          <Route path="/testing" element={<Testing />} />
          <Route path="/deploy" element={<Deploy />} />
          <Route path="/content" element={<Content />} />
          <Route path="/library" element={<Library />} />

          {/* Catch-all redirect */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        <SettingsSidebar />
        <LanguageButton />
        <HelpButton />
      </div>
    </BrowserRouter>
  );
}