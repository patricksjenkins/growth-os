import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

type NavItem = { to?: string; href?: string; label: string; icon: string; external?: boolean };
type NavGroup = { label: string; items: NavItem[] };

const HOMEADVISOR_REVIEWS = 'https://www.homeadvisor.com/rated.AKutAboveTreeServices.80372032.html';

const OWNER_GROUPS: NavGroup[] = [
  { label: 'Workspace', items: [
    { to: '/', label: 'Dashboard', icon: '\u{1F4CA}' },
    { to: '/leads', label: 'Leads', icon: '\u{1F4CB}' },
    { to: '/customers', label: 'Customers', icon: '\u{1F465}' },
    { to: '/jobs', label: 'Jobs', icon: '\u{2705}' },
  ]},
  { label: 'Operations', items: [
    { to: '/crew', label: 'Crew', icon: '\u{1F477}' },
    { to: '/photos', label: 'Job Photos', icon: '\u{1F4F7}' },
  ]},
  { label: 'Growth', items: [
    { href: HOMEADVISOR_REVIEWS, label: 'Reviews', icon: '\u{2B50}', external: true },
    { to: '/referrals', label: 'Referrals', icon: '\u{1F91D}' },
  ]},
  { label: 'Financial', items: [
    { to: '/income', label: 'Income', icon: '\u{1F4B5}' },
    { to: '/expenses', label: 'Expenses', icon: '\u{1F4B8}' },
    { to: '/invoices', label: 'Invoices', icon: '\u{1F9FE}' },
    { to: '/debt', label: 'Debt Tracker', icon: '\u{1F4C9}' },
    { to: '/reports', label: 'Reports', icon: '\u{1F4C4}' },
  ]},
];

const CREW_GROUPS: NavGroup[] = [
  { label: 'My Work', items: [
    { to: '/jobs', label: 'Jobs', icon: '\u{2705}' },
    { to: '/photos', label: 'Job Photos', icon: '\u{1F4F7}' },
  ]},
];

export default function Layout() {
  const { logout, isCrew } = useAuth();
  const groups = isCrew ? CREW_GROUPS : OWNER_GROUPS;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/logo.png" alt="A Kut Above Tree Services" className="sidebar-logo-img" />
        </div>
        <nav className="sidebar-nav">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) =>
                item.external ? (
                  <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer" className="nav-link">
                    <span className="nav-icon">{item.icon}</span>
                    {item.label}
                    <span className="nav-count" title="Reviews live on HomeAdvisor">HA</span>
                  </a>
                ) : (
                  <NavLink
                    key={item.to}
                    to={item.to!}
                    end={item.to === '/'}
                    className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                  >
                    <span className="nav-icon">{item.icon}</span>
                    {item.label}
                  </NavLink>
                )
              )}
            </div>
          ))}
        </nav>
      </aside>
      <div className="main-area">
        <header className="top-header">
          <img src="/logo.png" alt="A Kut Above Tree Services" className="header-logo" />
          <div className="header-actions">
            <button className="btn-logout" onClick={logout}>Logout</button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
