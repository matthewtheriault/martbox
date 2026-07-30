import { Routes, Route, useLocation } from 'react-router-dom'
import { PortProvider } from './lib/PortContext'
import Sidebar from './components/Sidebar'
import Home from './pages/Home'
import Movies from './pages/Movies'
import TvShows from './pages/TvShows'
import MovieDetail from './pages/MovieDetail'
import ShowDetail from './pages/ShowDetail'
import Player from './pages/Player'
import Settings from './pages/Settings'

export default function App(): JSX.Element {
  const location = useLocation()
  const isPlayerRoute = location.pathname.startsWith('/play/')

  return (
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
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </PortProvider>
  )
}
