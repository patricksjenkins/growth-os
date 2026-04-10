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
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
