import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './context/Auth';
import { Shell } from './components/Shell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Loading } from './components/ui';
import Login from './pages/Login';
import Signup from './pages/Signup';
import AcceptInvite from './pages/AcceptInvite';

// Signed-in screens are split out of the entry bundle: recharts (Dashboard, Reporting),
// dnd-kit (Pipeline) and tanstack-table (Leads) are large and none of them are needed to
// render the sign-in page or the first paint of the inbox.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Pipeline = lazy(() => import('./pages/Pipeline'));
const Leads = lazy(() => import('./pages/Leads'));
const OpportunityDetail = lazy(() => import('./pages/OpportunityDetail'));
const Activities = lazy(() => import('./pages/Operations').then(module => ({ default: module.Activities })));
const Calendar = lazy(() => import('./pages/Operations').then(module => ({ default: module.Calendar })));
const Contacts = lazy(() => import('./pages/Operations').then(module => ({ default: module.Contacts })));
const Reporting = lazy(() => import('./pages/Reporting'));
const Configuration = lazy(() => import('./pages/Configuration'));
const Notifications = lazy(() => import('./pages/Notifications'));
const WhatsApp = lazy(() => import('./pages/WhatsApp'));
const WhatsAppSettings = lazy(() => import('./pages/whatsapp/Settings'));

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading/>;

  if (!user) return <Routes>
    <Route path="/login" element={<Login/>}/>
    <Route path="/signup" element={<Signup/>}/>
    <Route path="/accept-invite" element={<AcceptInvite/>}/>
    <Route path="*" element={<Navigate to="/login" replace/>}/>
  </Routes>;

  const canConfigure = ['Administrator', 'Sales Manager'].includes(user.role.name);
  return <Shell>
    {/* Keyed on the path so navigating away from a screen that threw clears the error. */}
    <ErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<Loading/>}>
        <Routes>
          <Route path="/" element={<Dashboard/>}/>
          <Route path="/pipeline" element={<Pipeline/>}/>
          <Route path="/leads" element={<Leads/>}/>
          <Route path="/opportunities/:id" element={<OpportunityDetail/>}/>
          <Route path="/activities" element={<Activities/>}/>
          <Route path="/calendar" element={<Calendar/>}/>
          <Route path="/contacts" element={<Contacts/>}/>
          <Route path="/reporting" element={<Reporting/>}/>
          <Route path="/whatsapp" element={<WhatsApp/>}/>
          <Route path="/whatsapp/settings" element={canConfigure ? <WhatsAppSettings/> : <Navigate to="/whatsapp" replace/>}/>
          <Route path="/configuration" element={canConfigure ? <Configuration/> : <Navigate to="/" replace/>}/>
          <Route path="/notifications" element={<Notifications/>}/>
          <Route path="/login" element={<Navigate to="/" replace/>}/>
          <Route path="/signup" element={<Navigate to="/" replace/>}/>
          <Route path="/accept-invite" element={<Navigate to="/" replace/>}/>
          <Route path="*" element={<Navigate to="/" replace/>}/>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  </Shell>;
}
