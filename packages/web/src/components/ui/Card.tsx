interface CardProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
}

export function Card({ children, className = '', title }: CardProps) {
  return (
    <div className={`bg-white rounded-xl shadow-sm border border-gray-100 p-6 ${className}`}>
      {title && <h3 className="text-base font-semibold text-gray-700 mb-4">{title}</h3>}
      {children}
    </div>
  );
}
