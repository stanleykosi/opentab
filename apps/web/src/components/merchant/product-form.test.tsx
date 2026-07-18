import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProductForm } from './product-form';

describe('ProductForm production defaults', () => {
  it('starts live product creation with an honest blank offer', () => {
    render(<ProductForm mode="live" />);

    expect(screen.getByLabelText('Product or event name')).toHaveValue('');
    expect(screen.getByLabelText('URL slug')).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByLabelText('Price (USDC)')).toHaveValue('');
    expect(screen.getByLabelText('Inventory')).toHaveValue('');
    expect(screen.getByLabelText('Maximum per customer')).toHaveValue('1');
    expect(screen.getByLabelText('Starts at')).toHaveValue('');
    expect(screen.getByLabelText('Ends at')).toHaveValue('');
    expect(screen.getByLabelText('Loyalty points')).toHaveValue('0');
    expect(screen.getByRole('link', { name: 'Discard draft' })).toHaveAttribute(
      'href',
      '/merchant/products',
    );
  });
});
