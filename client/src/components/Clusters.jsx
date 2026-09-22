import React from 'react';
import { Target, ArrowRight } from 'lucide-react';

export default function Clusters({ clustersData }) {
  if (!clustersData) {
    return <div className="animate-in">Loading clusters...</div>;
  }
  
  if (clustersData.error || !clustersData.clusters) {
    return (
      <div className="animate-in glass-panel" style={{ padding: '3rem', textAlign: 'center' }}>
        <h2 style={{ marginBottom: '1rem' }}>No Clusters Found</h2>
        <p style={{ color: 'var(--text-secondary)' }}>{clustersData.error || "The pipeline hasn't generated clusters yet."}</p>
      </div>
    );
  }

  return (
    <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <header>
        <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>Opportunity Clusters</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          Ranked groups of incomplete-memory retrieval failures based on composite opportunity score.
        </p>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {clustersData.clusters.map((cluster, idx) => (
          <div key={idx} className="glass-panel" style={{ padding: '2rem', display: 'flex', gap: '2rem' }}>
            
            {/* Left side: Metrics */}
            <div style={{ flex: '0 0 250px', borderRight: '1px solid var(--border-subtle)', paddingRight: '2rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                <span className="badge badge-blue">Rank #{cluster.rank}</span>
                <span className="badge badge-purple">Score: {cluster.composite_score}</span>
              </div>
              
              <h3 style={{ fontSize: '1.25rem', marginBottom: '1.5rem', color: 'var(--text-primary)' }}>
                {cluster.label}
              </h3>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>Cluster Size</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{cluster.size} records</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>Abandonment Rate</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f87171' }}>{cluster.abandonment_pct}%</div>
                </div>
              </div>
            </div>

            {/* Right side: Details */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ marginBottom: '1.5rem' }}>
                <h4 style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
                  Top Features (Remembered Attributes)
                </h4>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {cluster.top_features.split(',').map((feat, i) => (
                    <span key={i} className="badge badge-pink">{feat.trim()}</span>
                  ))}
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
                  Representative Quote
                </h4>
                <blockquote style={{ 
                  borderLeft: '3px solid var(--brand-primary)', 
                  paddingLeft: '1rem',
                  color: 'var(--text-primary)',
                  fontStyle: 'italic',
                  fontSize: '1.1rem',
                  lineHeight: 1.6
                }}>
                  "{cluster.quote}"
                </blockquote>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
