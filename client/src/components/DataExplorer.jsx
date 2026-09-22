import React, { useState, useEffect } from 'react';
import { Search, Filter, ChevronLeft, ChevronRight } from 'lucide-react';

export default function DataExplorer() {
  const [data, setData] = useState({ data: [], total: 0, page: 1, total_pages: 1 });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    source: '',
    photo_type: '',
    failure_point: ''
  });

  const fetchRecords = (page = 1) => {
    setLoading(true);
    let url = `/api/records?page=${page}&limit=20`;
    if (filters.source) url += `&source=${filters.source}`;
    if (filters.photo_type) url += `&photo_type=${filters.photo_type}`;
    if (filters.failure_point) url += `&failure_point=${filters.failure_point}`;

    fetch(url)
      .then(res => res.json())
      .then(resData => {
        setData(resData);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchRecords(1);
  }, [filters]);

  const handleFilterChange = (e) => {
    setFilters({ ...filters, [e.target.name]: e.target.value });
  };

  return (
    <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem', height: '100%' }}>
      <header>
        <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>Data Explorer</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          Filter and browse raw and extracted records from the pipeline.
        </p>
      </header>

      {/* Filters */}
      <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)' }}>
          <Filter size={18} />
          <span style={{ fontWeight: 600 }}>Filters:</span>
        </div>

        <select 
          name="source" 
          value={filters.source} 
          onChange={handleFilterChange}
          style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', background: 'rgba(0,0,0,0.3)', color: 'white', border: '1px solid var(--border-subtle)' }}
        >
          <option value="">All Sources</option>
          <option value="reddit">Reddit</option>
          <option value="youtube">YouTube</option>
          <option value="playstore">Play Store</option>
          <option value="appstore">App Store</option>
          <option value="helpcommunity">Help Community</option>
        </select>

        <select 
          name="photo_type" 
          value={filters.photo_type} 
          onChange={handleFilterChange}
          style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', background: 'rgba(0,0,0,0.3)', color: 'white', border: '1px solid var(--border-subtle)' }}
        >
          <option value="">All Photo Types</option>
          <option value="person">Person</option>
          <option value="place">Place</option>
          <option value="event">Event</option>
          <option value="document">Document</option>
          <option value="screenshot">Screenshot</option>
          <option value="receipt">Receipt</option>
          <option value="pet">Pet</option>
        </select>

        <select 
          name="failure_point" 
          value={filters.failure_point} 
          onChange={handleFilterChange}
          style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', background: 'rgba(0,0,0,0.3)', color: 'white', border: '1px solid var(--border-subtle)' }}
        >
          <option value="">All Failure Points</option>
          <option value="no results">No Results</option>
          <option value="too many results">Too Many Results</option>
          <option value="couldn't formulate query">Couldn't Formulate</option>
          <option value="wrong result surfaced">Wrong Result</option>
        </select>
      </div>

      {/* Table */}
      <div className="table-container" style={{ flex: 1 }}>
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading data...</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Raw Text</th>
                <th>Photo Type</th>
                <th>Remembered</th>
                <th>Failure Point</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {data.data?.map(record => (
                <tr key={record.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className="badge badge-blue">{record.id}</span>
                  </td>
                  <td style={{ maxWidth: '400px' }}>
                    <div style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}>
                      {record.raw_text}
                    </div>
                  </td>
                  <td>{record.photo_type}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                      {(record.remembered_attributes || []).slice(0, 2).map((a, i) => (
                        <span key={i} className="badge badge-purple" style={{ fontSize: '0.65rem' }}>{a}</span>
                      ))}
                      {(record.remembered_attributes || []).length > 2 && <span className="badge badge-purple" style={{ fontSize: '0.65rem' }}>+</span>}
                    </div>
                  </td>
                  <td><span className="badge badge-red">{record.failure_point}</span></td>
                  <td>{record.outcome}</td>
                </tr>
              ))}
              {data.data?.length === 0 && (
                <tr>
                  <td colSpan="6" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                    No records match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          Showing {(data.page - 1) * data.limit + 1} to {Math.min(data.page * data.limit, data.total)} of {data.total} records
        </span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            disabled={data.page === 1}
            onClick={() => fetchRecords(data.page - 1)}
            style={{ padding: '0.5rem', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'white', cursor: data.page === 1 ? 'not-allowed' : 'pointer' }}
          >
            <ChevronLeft size={18} />
          </button>
          <button 
            disabled={data.page === data.total_pages || data.total_pages === 0}
            onClick={() => fetchRecords(data.page + 1)}
            style={{ padding: '0.5rem', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'white', cursor: (data.page === data.total_pages || data.total_pages === 0) ? 'not-allowed' : 'pointer' }}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
