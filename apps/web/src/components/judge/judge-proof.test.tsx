import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mapPublicJudgeProofToView } from '../../application/live-view-mappers';
import { JudgeProof } from './judge-proof';
import { unrecordedRoutePublicJudgeProof } from './public-judge-proof.test-fixture';

describe('Judge proof presentation', () => {
  it('labels absent route evidence without formatting a sentinel as money', () => {
    render(<JudgeProof proof={mapPublicJudgeProofToView(unrecordedRoutePublicJudgeProof)} />);

    expect(screen.getByText('Source assets not recorded')).toBeInTheDocument();
    expect(screen.getAllByText('Not recorded').length).toBeGreaterThan(0);
    expect(document.body.textContent?.toLowerCase()).not.toContain('$not-recorded');
    expect(document.body.textContent).not.toContain('$Not recorded');
  });
});
