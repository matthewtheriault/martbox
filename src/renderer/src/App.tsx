import { lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { PortProvider } from './lib/PortContext'
import { ProfileProvider } from './lib/ProfileContext'
import Sidebar from './components/Sidebar'
import ServerVersionBanner from './components/ServerVersionBanner'

const Home = lazy(() => import('./pages/Home'))
const Movies = lazy(() => import('./pages/Movies'))
const TvShows = lazy(() => import('./pages/TvShows'))
const MovieDetail = lazy(() => import('./pages/MovieDetail'))
const ShowDetail = lazy(() => import('./pages/ShowDetail'))
const Player = lazy(() => import('./pages/Player'))
const Activity = lazy(() => import('./pages/Activity'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Requests = lazy(() => import('./pages/Requests'))
const Settings = lazy(() => import('./pages/Settings'))
const Search = lazy(() => import('./pages/Search'))

export default function App(): JSX.Element {
  const location = useLocation()
  const isPlayerRoute = location.pathname.startsWith('/play/')

  return (
    <ProfileProvider>
      <PortProvider>
        <div className={isPlayerRoute ? 'app-shell app-shell-immersive' : 'app-shell'}>
          {!isPlayerRoute && <Sidebar />}
          <main className={isPlayerRoute ? 'app-content app-content-full' : 'app-content'}>
            {!isPlayerRoute && <ServerVersionBanner />}
            <Suspense fallback={<div className="route-loading" />}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/movies" element={<Movies />} />
                <Route path="/tv" element={<TvShows />} />
                <Route path="/movie/:id" element={<MovieDetail />} />
                <Route path="/show/:id" element={<ShowDetail />} />
                <Route path="/play/:mediaType/:id" element={<Player />} />
                <Route path="/activity" element={<Activity />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/requests" element={<Requests />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/search" element={<Search />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </PortProvider>
    </ProfileProvider>
  )
}
