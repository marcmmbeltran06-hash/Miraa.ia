import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from '../../src/components/ui/Badge.tsx';

describe('Badge', () => {
  it('renders label text', () => {
    render(<Badge label="hello" />);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('applies success variant classes', () => {
    const { container } = render(<Badge label="OK" variant="success" />);
    const el = container.firstElementChild;
    expect(el).toHaveClass('bg-green-100');
    expect(el).toHaveClass('text-green-700');
  });

  it('applies danger variant classes', () => {
    const { container } = render(<Badge label="Error" variant="danger" />);
    const el = container.firstElementChild;
    expect(el).toHaveClass('bg-red-100');
  });

  it('applies custom className', () => {
    const { container } = render(<Badge label="X" className="extra-class" />);
    expect(container.firstElementChild).toHaveClass('extra-class');
  });
});
