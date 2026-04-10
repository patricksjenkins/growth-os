import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

interface RoleRouteProps {
  ownerElement: React.ReactElement;
  crewRedirect: string;
}

export default function RoleRoute({ ownerElement, crewRedirect }: RoleRouteProps) {
  const { isCrew } = useAuth();

  if (isCrew) {
    return <Navigate to={crewRedirect} replace />;
  }

  return ownerElement;
}
