import { Routes, Route, useLocation } from 'react-router-dom'
import { PortProvider } from './lib/PortContext'
import { ProfileProvider } from './lib/ProfileContext'
import Sidebar from './components/Sidebar'
import Home from './pages/Home'
import Movies from './pages/Movies'
import TvShows from './pages/TvShows'
import MovieDetail from './pages/MovieDetail'
import ShowDetail from './pages/ShowDetail'
import Player from './pages/Player'
import LiveTv from './pages/LiveTv'
import LiveChannelPlayer from './pages/LiveChannelPlayer'
import Activity from './pages/Activity'
import Settings from './pages/Settings'

export default function App(): JSX.Element {
  const location = useLocation()
  const isPlayerRoute = location.pathname.startsWith('/play/')

  return (
    <ProfileProvider>
      <PortProvider>
        <div className={isPlayerRoute ? 'app-shell app-shell-immersive' : 'app-shell'}>
          {!isPlayerRoute && <Sidebar />}
          <main className={isPlayerRoute ? 'app-content app-content-full' : 'app-content'}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/movies" element={<Movies />} />
              <Route path="/tv" element={<TvShows />} />
              <Route path="/movie/:id" element={<MovieDetail />} />
              <Route path="/show/:id" element={<ShowDetail />} />
              <Route path="/play/:mediaType/:id" element={<Player />} />
              <Route path="/live" element={<LiveTv />} />
              <Route path="/play/live/:channelId" element={<LiveChannelPlayer />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </PortProvider>
    </ProfileProvider>
  )
}
