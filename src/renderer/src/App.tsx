import { lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { PortProvider } from './lib/PortContext'
import { ProfileProvider } from './lib/ProfileContext'
import Sidebar from './components/Sidebar'
import ServerVersionBanner from './components/ServerVersionBanner'
import CommandPalette from './components/CommandPalette'
import NowPlayingBar from './components/NowPlayingBar'

const Home = lazy(() => import('./pages/Home'))
const Movies = lazy(() => import('./pages/Movies'))
const TvShows = lazy(() => import('./pages/TvShows'))
const MovieDetail = lazy(() => import('./pages/MovieDetail'))
const ShowDetail = lazy(() => import('./pages/ShowDetail'))
const Player = lazy(() => import('./pages/Player'))
const Activity = lazy(() => import('./pages/Activity'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Requests = lazy(() => import('./pages/Requests'))
const Live = lazy(() => import('./pages/Live'))
const LivePlayer = lazy(() => import('./pages/LivePlayer'))
const Settings = lazy(() => import('./pages/Settings'))
const Search = lazy(() => import('./pages/Search'))
const Collections = lazy(() => import('./pages/Collections'))
const YearInReview = lazy(() => import('./pages/YearInReview'))
const Music = lazy(() => import('./pages/Music'))

export default function App(): JSX.Element {
  const location = useLocation()
  // Full-screen pages: the player, and watching a Live Channel.
  const isPlayerRoute =
    location.pathname.startsWith('/play/') || /^\/live\/\d+/.test(location.pathname)

  return (
    <PortProvider>
      <ProfileProvider>
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
                <Route path="/live" element={<Live />} />
                <Route path="/live/:id" element={<LivePlayer />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/search" element={<Search />} />
                <Route path="/collections" element={<Collections />} />
                <Route path="/collections/:id" element={<Collections />} />
                <Route path="/year" element={<YearInReview />} />
                <Route path="/music" element={<Music />} />
                <Route path="/music/album/:albumId" element={<Music />} />
                <Route path="/music/artist/:artistId" element={<Music />} />
                <Route path="/music/genre/:genre" element={<Music />} />
                <Route path="/music/playlist/:playlistId" element={<Music />} />
                <Route path="/music/listening/:kind" element={<Music />} />
              </Routes>
            </Suspense>
          </main>
          {!isPlayerRoute && <NowPlayingBar />}
          <CommandPalette />
        </div>
      </ProfileProvider>
    </PortProvider>
  )
}
