let scriptLoadingPromise: Promise<void> | null = null;

export function loadGoogleScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Browser environment required to load Google Identity Services script'));
  }
  
  if (window.google?.accounts?.id) {
    return Promise.resolve();
  }
  
  if (scriptLoadingPromise) {
    return scriptLoadingPromise;
  }
  
  scriptLoadingPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      resolve();
    };
    script.onerror = (err) => {
      scriptLoadingPromise = null;
      reject(new Error('Failed to load Google Identity Services script'));
    };
    document.head.appendChild(script);
  });
  
  return scriptLoadingPromise;
}
