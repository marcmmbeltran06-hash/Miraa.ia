import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const { startSingleCampaign, startExcelCampaign, getCampaignStatus } = vi.hoisted(() => ({
  startSingleCampaign: vi.fn(async () => ({ campaignId: 'campaign-abc', totalRequested: 1 })),
  startExcelCampaign: vi.fn(async () => ({ campaignId: 'campaign-excel', totalRequested: 1830 })),
  getCampaignStatus: vi.fn(async () => ({ campaignId: 'campaign-abc', status: 'starting' })),
}));
vi.mock('../../src/api/crawl.ts', () => ({
  crawlApi: { startSingleCampaign, startExcelCampaign, getCampaignStatus },
}));

import { HomePage } from '../../src/pages/HomePage.tsx';

function renderPage() {
  return render(<HomePage />, { wrapper: MemoryRouter });
}

describe('Mira campaign launcher', () => {
  beforeEach(() => {
    startSingleCampaign.mockClear();
    startExcelCampaign.mockClear();
    getCampaignStatus.mockClear();
  });

  it('offers a single-site test and an Excel campaign', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /probar una web/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /crear desde excel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /analizar y generar prueba/i })).toBeDisabled();
  });

  it('rejects invalid URLs before starting the test', async () => {
    renderPage();
    const input = screen.getByLabelText(/url de la web/i);
    await userEvent.type(input, 'not-a-url');
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText(/url http o https válida/i)).toBeInTheDocument();
    expect(startSingleCampaign).not.toHaveBeenCalled();
  });

  it('starts a valid individual report', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText(/url de la web/i), 'https://tienda.example');
    await userEvent.click(screen.getByRole('button', { name: /analizar y generar prueba/i }));
    expect(startSingleCampaign).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://tienda.example', publish: true }));
    expect(await screen.findByText(/campaña en marcha/i)).toBeInTheDocument();
  });
});
