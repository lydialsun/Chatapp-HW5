import { useState } from 'react';
import Auth from './components/Auth';
import Chat from './components/Chat';
import YouTubeChannelDownload from './components/YouTubeChannelDownload';
import './App.css';

function App() {
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem('chatapp_user');
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && data.username ? data : null;
    } catch {
      return null;
    }
  });

  const [activeTab, setActiveTab] = useState('chat');

  const handleLogin = (userData) => {
    const u = typeof userData === 'string' ? { username: userData, firstName: null, lastName: null } : userData;
    localStorage.setItem('chatapp_user', JSON.stringify(u));
    setUser(u);
  };

  const handleLogout = () => {
    localStorage.removeItem('chatapp_user');
    setUser(null);
  };

  if (!user) return <Auth onLogin={handleLogin} />;

  return (
    <div className="app-logged-in">
      <header className="app-tabs">
        <button
          type="button"
          className={activeTab === 'chat' ? 'active' : ''}
          onClick={() => setActiveTab('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          className={activeTab === 'youtube' ? 'active' : ''}
          onClick={() => setActiveTab('youtube')}
        >
          YouTube Channel Download
        </button>
        <span className="app-user-name">
          {[user.firstName, user.lastName].filter(Boolean).join(' ') || user.username}
        </span>
        <button type="button" className="app-logout" onClick={handleLogout}>
          Log out
        </button>
      </header>
      {activeTab === 'chat' && <Chat user={user} onLogout={handleLogout} />}
      {activeTab === 'youtube' && <YouTubeChannelDownload />}
    </div>
  );
}

export default App;
