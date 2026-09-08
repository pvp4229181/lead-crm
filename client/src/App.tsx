import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/Auth';
import { Shell } from './components/Shell';
import { Loading } from './components/ui';
import Login from './pages/Login';
import Signup from './pages/Signup';
import AcceptInvite from './pages/AcceptInvite';
import Dashboard from './pages/Dashboard';
import Pipeline from './pages/Pipeline';
import Leads from './pages/Leads';
import OpportunityDetail from './pages/OpportunityDetail';
import { Activities, Calendar, Contacts } from './pages/Operations';
import Reporting from './pages/Reporting';
import Configuration from './pages/Configuration';
import Notifications from './pages/Notifications';
import WhatsApp from './pages/WhatsApp';
import WhatsAppSettings from './pages/whatsapp/Settings';

export default function App(){
  const {user,loading}=useAuth();
  if(loading)return <Loading/>;
  if(!user)return <Routes><Route path="/login" element={<Login/>}/><Route path="/signup" element={<Signup/>}/><Route path="/accept-invite" element={<AcceptInvite/>}/><Route path="*" element={<Navigate to="/login" replace/>}/></Routes>;
  return <Shell><Routes><Route path="/" element={<Dashboard/>}/><Route path="/pipeline" element={<Pipeline/>}/><Route path="/leads" element={<Leads/>}/><Route path="/opportunities/:id" element={<OpportunityDetail/>}/><Route path="/activities" element={<Activities/>}/><Route path="/calendar" element={<Calendar/>}/><Route path="/contacts" element={<Contacts/>}/><Route path="/reporting" element={<Reporting/>}/><Route path="/whatsapp" element={<WhatsApp/>}/><Route path="/whatsapp/settings" element={['Administrator','Sales Manager'].includes(user.role.name)?<WhatsAppSettings/>:<Navigate to="/whatsapp"/>}/><Route path="/configuration" element={['Administrator','Sales Manager'].includes(user.role.name)?<Configuration/>:<Navigate to="/"/>}/><Route path="/notifications" element={<Notifications/>}/><Route path="/login" element={<Navigate to="/" replace/>}/><Route path="/signup" element={<Navigate to="/" replace/>}/><Route path="/accept-invite" element={<Navigate to="/" replace/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Routes></Shell>;
}
