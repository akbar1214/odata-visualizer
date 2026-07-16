const API_BASE = '/api';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  query?: string;
}

export async function sendMessage(
  sessionId: string,
  message: string
): Promise<{ response: string; query?: string }> {
  const response = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sessionId, message }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Network error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
