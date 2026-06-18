import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import RoleRoute from './components/RoleRoute';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Income from './pages/Income';
import Expenses from './pages/Expenses';
import Customers from './pages/Customers';
import Crew from './pages/Crew';
import Debt from './pages/Debt';
import Reports from './pages/Reports';
import Jobs from './pages/Jobs';
import Leads from './pages/Leads';
import Placeholder from './pages/Placeholder';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 60000,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<RoleRoute ownerElement={<Dashboard />} crewRedirect="/jobs" />} />
            <Route path="income" element={<RoleRoute ownerElement={<Income />} crewRedirect="/jobs" />} />
            <Route path="expenses" element={<RoleRoute ownerElement={<Expenses />} crewRedirect="/jobs" />} />
            <Route path="customers" element={<RoleRoute ownerElement={<Customers />} crewRedirect="/jobs" />} />
            <Route path="crew" element={<RoleRoute ownerElement={<Crew />} crewRedirect="/jobs" />} />
            <Route path="debt" element={<RoleRoute ownerElement={<Debt />} crewRedirect="/jobs" />} />
            <Route path="reports" element={<RoleRoute ownerElement={<Reports />} crewRedirect="/jobs" />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="leads" element={<RoleRoute ownerElement={<Leads />} crewRedirect="/jobs" />} />
            <Route path="photos" element={<Placeholder title="Job Photos" icon={'\u{1F4F7}'} description="Before & after photos uploaded by the crew." note="Crew photos appear here once the field crew starts uploading them from the mobile app." />} />
            <Route path="referrals" element={<RoleRoute ownerElement={<Placeholder title="Referrals" icon={'\u{1F91D}'} description="Referral rewards and partner sends." note="Referral activity will populate here as the referral agent sends and tracks them." />} crewRedirect="/jobs" />} />
            <Route path="invoices" element={<RoleRoute ownerElement={<Placeholder title="Invoices" icon={'\u{1F9FE}'} description="Customer invoices and payment status." note="Invoices will appear here as jobs are billed. Income is already tracked under Financial \u2192 Income." />} crewRedirect="/jobs" />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
