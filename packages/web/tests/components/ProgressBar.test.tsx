import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ProgressBar } from '../../src/components/ui/ProgressBar.tsx';

describe('ProgressBar', () => {
  it('renders with correct aria attributes', () => {
    render(<ProgressBar value={60} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('shows percentage label when showValue is true', () => {
    render(<ProgressBar value={42} showValue />);
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('clamps value to 0–100', () => {
    render(<ProgressBar value={150} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('shows the label text', () => {
    render(<ProgressBar value={50} label="Crawling" />);
    expect(screen.getByText('Crawling')).toBeInTheDocument();
  });
});
