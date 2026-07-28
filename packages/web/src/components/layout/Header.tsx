import { Link } from 'react-router-dom';

export function Header() {
  return (
    <header className="border-b border-gray-200 bg-white shadow-sm">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link to="/informes" className="flex items-center gap-2 font-bold text-gray-900 transition-colors hover:text-cyan-700">
          <span className="text-xl text-cyan-600" aria-hidden="true">◉</span>
          AutoWP Informes
        </Link>
        <nav className="hidden items-center gap-4 text-sm text-gray-600 sm:flex">
          <Link to="/versiones" className="transition-colors hover:text-cyan-700">Versiones por sector</Link>
          <Link to="/informes" className="transition-colors hover:text-cyan-700">Informes por lote</Link>
          <Link to="/" className="transition-colors hover:text-cyan-700">Crear WordPress</Link>
        </nav>
      </div>
    </header>
  );
}
