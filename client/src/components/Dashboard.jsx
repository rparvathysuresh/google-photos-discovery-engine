import React from 'react';
import { Target, Users, AlertTriangle, TrendingUp } from 'lucide-react';

export default function Dashboard({ status, clustersData }) {
  if (!status || !clustersData) {
    return <div className="animate-in">Loading dashboard data...</div>;
  }

  if (clustersData.error) {
    return (
      <div className="animate-in glass-panel" style={{ padding: '3rem', textAlign: 'center' }}>
        <AlertTriangle size={48} color="#f59e0b" style={{ margin: '0 auto 1rem' }} />
        <h2>Data Not Ready</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>{clustersData.error}</p>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem', fontSize: '0.9rem' }}>The pipeline is currently running. Please check back when it finishes.</p>
      </div>
    );
  }

  const { summary_markdown } = clustersData;
  const numClusters = clustersData.clusters?.length || 0;

  // Simple markdown renderer for the narrative summary
  const renderMarkdown = (md) => {
    return { __html: md.replace(/### (.*)/g, '<h3>$1</h3>')
                        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                        .replace(/\n\n/g, '<br/><br/>')
                        .replace(/- "(.*?)"/g, '<li>"$1"</li>') };
  };

  return (
    <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <header>
        <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>Executive Summary</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          High-level narrative and metrics for incomplete-memory retrieval failures.
        </p>
      </header>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1.5rem' }}>
        <div className="glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: 500 }}>Total Analyzed</span>
            <Target size={20} color="var(--brand-primary)" />
          </div>
          <h2 style={{ fontSize: '2rem' }}>{status.extracted_records}</h2>
          <p style={{ fontSize: '0.8rem', color: '#14b8a6', marginTop: '0.5rem' }}>Structured records</p>
        </div>

        <div className="glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: 500 }}>Clusters Found</span>
            <NetworkIcon size={20} color="var(--brand-secondary)" />
          </div>
          <h2 style={{ fontSize: '2rem' }}>{numClusters}</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>Distinct failure patterns</p>
        </div>

        <div className="glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: 500 }}>Avg Abandonment</span>
            <AlertTriangle size={20} color="#f59e0b" />
          </div>
          <h2 style={{ fontSize: '2rem' }}>
            {clustersData.clusters?.length ? 
              Math.round(clustersData.clusters.reduce((acc, c) => acc + parseFloat(c.abandonment_pct), 0) / numClusters) 
              : 0}%
          </h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>Across all clusters</p>
        </div>

        <div className="glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: 500 }}>Processing Error Rate</span>
            <TrendingUp size={20} color="var(--brand-tertiary)" />
          </div>
          <h2 style={{ fontSize: '2rem' }}>{status.error_rate}</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>During LLM extraction</p>
        </div>
      </div>

      {/* Narrative Summary */}
      <div className="glass-panel" style={{ padding: '2.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '1rem' }}>
          <Users size={24} color="var(--brand-primary)" />
          <h2 style={{ fontSize: '1.5rem' }}>PM Analyst Narrative</h2>
        </div>
        
        <div 
          className="markdown-content"
          dangerouslySetInnerHTML={renderMarkdown(summary_markdown)} 
        />
      </div>
    </div>
  );
}

// Inline Icon to avoid extra imports for one usage
function NetworkIcon(props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="16" y="16" width="6" height="6" rx="1"/>
      <rect x="2" y="16" width="6" height="6" rx="1"/>
      <rect x="9" y="2" width="6" height="6" rx="1"/>
      <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/>
      <path d="M12 12V8"/>
    </svg>
  );
}
