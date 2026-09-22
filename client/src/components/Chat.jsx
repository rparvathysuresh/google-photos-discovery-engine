import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';

export default function Chat() {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hello! I am the PM Discovery AI. I can answer questions about the Google Photos review data. What would you like to know?' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only send user/assistant messages to the backend, exclude the greeting if needed, 
        // but here it's fine to send the whole history.
        body: JSON.stringify({ messages: newMessages })
      });
      
      const data = await response.json();
      
      if (data.error) {
        setMessages([...newMessages, { role: 'assistant', content: `Error: ${data.error}` }]);
      } else {
        setMessages([...newMessages, { role: 'assistant', content: data.reply }]);
      }
    } catch (error) {
      console.error(error);
      setMessages([...newMessages, { role: 'assistant', content: 'Failed to connect to the server.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  // Simple markdown renderer for bold and lists
  const renderMessageContent = (content) => {
    // Escape HTML first to be safe
    let html = content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Lists
    html = html.replace(/^- (.*)/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    // Line breaks
    html = html.replace(/\n/g, '<br/>');
    return <div dangerouslySetInnerHTML={{ __html: html }} style={{ lineHeight: 1.5 }} />;
  };

  return (
    <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>Ask AI</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          Query the pipeline dataset directly using natural language.
        </p>
      </header>

      <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
        
        {/* Chat History */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {messages.map((msg, idx) => (
            <div key={idx} style={{ 
              display: 'flex', 
              gap: '1rem',
              flexDirection: msg.role === 'user' ? 'row-reverse' : 'row'
            }}>
              <div style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                background: msg.role === 'user' ? 'var(--text-primary)' : 'var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}>
                {msg.role === 'user' ? <User size={18} color="black" /> : <Bot size={18} color="white" />}
              </div>
              
              <div style={{
                background: msg.role === 'user' ? 'var(--text-primary)' : 'var(--border-subtle)',
                color: msg.role === 'user' ? 'black' : 'var(--text-primary)',
                padding: '1rem',
                borderRadius: 'var(--radius-lg)',
                borderTopRightRadius: msg.role === 'user' ? '0' : 'var(--radius-lg)',
                borderTopLeftRadius: msg.role === 'assistant' ? '0' : 'var(--radius-lg)',
                maxWidth: '80%',
                fontSize: '0.95rem'
              }}>
                {renderMessageContent(msg.content)}
              </div>
            </div>
          ))}
          {isLoading && (
            <div style={{ display: 'flex', gap: '1rem' }}>
               <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Bot size={18} color="white" />
              </div>
              <div style={{ padding: '1rem', background: 'var(--border-subtle)', borderRadius: 'var(--radius-lg)', borderTopLeftRadius: '0' }}>
                <Loader2 size={18} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div style={{ padding: '1rem', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '1rem' }}>
            <input 
              type="text" 
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="E.g. What information do people actually remember about a photo?"
              style={{
                flex: 1,
                padding: '0.75rem 1rem',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                outline: 'none',
                fontSize: '0.95rem'
              }}
              disabled={isLoading}
            />
            <button 
              type="submit" 
              disabled={!input.trim() || isLoading}
              style={{
                background: 'var(--text-primary)',
                color: 'black',
                border: 'none',
                padding: '0 1.25rem',
                borderRadius: 'var(--radius-md)',
                cursor: (!input.trim() || isLoading) ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: (!input.trim() || isLoading) ? 0.5 : 1
              }}
            >
              <Send size={18} />
            </button>
          </form>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes spin { 100% { transform: rotate(360deg); } }
      `}} />
    </div>
  );
}
