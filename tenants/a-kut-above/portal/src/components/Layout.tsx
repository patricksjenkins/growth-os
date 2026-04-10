import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const OWNER_NAV = [
  { to: '/', label: 'Dashboard', icon: '\u{1F4CA}' },
  { to: '/income', label: 'Income', icon: '\u{1F4B5}' },
  { to: '/expenses', label: 'Expenses', icon: '\u{1F4B8}' },
  { to: '/customers', label: 'Customers', icon: '\u{1F465}' },
  { to: '/crew', label: 'Crew', icon: '\u{1F477}' },
  { to: '/debt', label: 'Debt Tracker', icon: '\u{1F4C9}' },
  { to: '/reports', label: 'Reports', icon: '\u{1F4C4}' },
  { to: '/jobs', label: 'Jobs', icon: '\u{2705}' },
  { to: '/leads', label: 'Leads', icon: '\u{1F4CB}' },
];

const CREW_NAV = [
  { to: '/jobs', label: 'Jobs', icon: '\u{2705}' },
];

export default function Layout() {
  const { logout, isCrew } = useAuth();
  const navItems = isCrew ? CREW_NAV : OWNER_NAV;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/logo.png" alt="A Kut Above Tree Services" className="sidebar-logo-img" />
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main-area">
        <header className="top-header">
          <img src="/logo.png" alt="A Kut Above Tree Services" className="header-logo" />
          <button className="btn-logout" onClick={logout}>Logout</button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
