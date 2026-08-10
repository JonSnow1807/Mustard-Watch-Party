import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FailureCard } from './FailureCard';

describe('FailureCard', () => {
  it('announces itself, and shows the URL so "why is it black" is answerable', () => {
    render(
      <FailureCard
        title="Couldn't play this video"
        detail="the CDN closed the connection"
        url="https://cdn.example.com/film.mp4"
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('https://cdn.example.com/film.mp4')).toBeInTheDocument();
  });

  it('offers a retry when one is given, and calls it', async () => {
    // a dead CDN or a flaky network is transient; before this, the only
    // recovery was reloading the page, which drops you out of the room
    const onRetry = jest.fn();
    render(<FailureCard title="Couldn't play this video" onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry where retrying cannot help', () => {
    // e.g. a URL no player can ever take - a button that always fails is
    // worse than no button
    render(<FailureCard title="No video set" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
