import { useState, useEffect } from 'react';
import { Dimensions, Platform } from 'react-native';

export function useResponsive() {
  const [width, setWidth] = useState(Dimensions.get('window').width);

  useEffect(() => {
    const handler = Dimensions.addEventListener('change', ({ window }) => setWidth(window.width));
    return () => handler?.remove();
  }, []);

  const isWeb = Platform.OS === 'web';
  const isDesktop = width >= 1024;
  const isTablet = width >= 768 && width < 1024;
  const isMobile = width < 768;

  return {
    isWeb,
    isDesktop,
    isTablet,
    isMobile,
    columns: isDesktop ? 6 : isTablet ? 4 : 3,
    sidebarWidth: isDesktop ? 240 : 0,
    maxWidth: isDesktop ? 1200 : '100%',
    width,
  };
}
