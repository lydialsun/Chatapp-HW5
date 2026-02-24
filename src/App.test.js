import { render, screen } from '@testing-library/react';
import App from './App';

test('renders auth screen when not logged in', () => {
  render(<App />);
  expect(screen.getByText(/chat/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/username/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/password/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create an account/i })).toBeInTheDocument();
});
