import { lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { PortProvider } from './lib/PortContext'
import { ProfileProvider } from './lib/ProfileContext'
import Sidebar from './components/Sidebar'
import ServerVersionBanner from './components/ServerVersionBanner'
import CommandPalette from './components/CommandPalette'
import NowPlayingBar from './components/NowPlayingBar'
import BookPlayerBar from './components/BookPlayerBar'
import Audiobooks from './pages/Audiobooks'
import Books from './pages/Books'
import Reader from './pages/Reader'
import Games, { GamePlayer } from './pages/Games'

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

// Which media type a page belongs to: it sets the page's colours (index.css, data-media).
function mediaOf(pathname: string): string | undefined {
  if (/^\/(music)(\/|$)/.test(pathname)) return 'music'
  if (/^\/(games|play-game)(\/|$)/.test(pathname)) return 'games'
  if (/^\/(books|read|audiobooks)(\/|$)/.test(pathname)) return 'books'
  if (/^\/($|movies|tv|movie|show|live|collections|search|requests)/.test(pathname)) return 'movies'
  return undefined
}

export default function App(): JSX.Element {
  const location = useLocation()
  // Full-screen pages: the player, watching a Live Channel, reading and playing a game.
  const isPlayerRoute =
    location.pathname.startsWith('/play/') ||
    /^\/live\/\d+/.test(location.pathname) ||
    location.pathname.startsWith('/read/') ||
    location.pathname.startsWith('/play-game/')

  return (
    <PortProvider>
      <ProfileProvider>
        <div className={isPlayerRoute ? 'app-shell app-shell-immersive' : 'app-shell'}>
          {!isPlayerRoute && <Sidebar />}
          <main className={isPlayerRoute ? 'app-content app-content-full' : 'app-content'} data-media={mediaOf(location.pathname)}>
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
                <Route path="/audiobooks" element={<Audiobooks />} />
                <Route path="/books" element={<Books />} />
                <Route path="/books/:bookId" element={<Books />} />
                <Route path="/read/:bookId" element={<Reader />} />
                <Route path="/games" element={<Games />} />
                <Route path="/games/:gameId" element={<Games />} />
                <Route path="/play-game/:gameId" element={<GamePlayer />} />
                <Route path="/audiobooks/:bookId" element={<Audiobooks />} />
                <Route path="/music/album/:albumId" element={<Music />} />
                <Route path="/music/artist/:artistId" element={<Music />} />
                <Route path="/music/genre/:genre" element={<Music />} />
                <Route path="/music/playlist/:playlistId" element={<Music />} />
                <Route path="/music/listening/:kind" element={<Music />} />
              </Routes>
            </Suspense>
          </main>
          {!isPlayerRoute && <NowPlayingBar />}
          {!isPlayerRoute && <BookPlayerBar />}
          <CommandPalette />
        </div>
      </ProfileProvider>
    </PortProvider>
  )
}
