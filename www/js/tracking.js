// ═══════════════ LOCATION TRACKING ═══════════════
let _locationWatcher = null;
let _locationInterval = null;  // 5-min fallback timer for background pings

// SW → page: SW periodicsync fires → asks page to get GPS
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'REQUEST_LOCATION') {
      if (CU && CU.role === 'sales_rep') _captureAndSaveLocation();
    }
  });
}

// Refresh when tab comes back into focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && CU && CU.role === 'sales_rep') {
    _captureAndSaveLocation();
  }
});

function _captureAndSaveLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      _userLat = pos.coords.latitude;
      _userLng = pos.coords.longitude;
      _gpsGranted = true;
      saveUserLocation(pos);
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function startLocationTracking() {
  if (!navigator.geolocation) return;
  // Admins are never tracked
  if (isAdmin()) return;

  // Immediate fix
  _captureAndSaveLocation();

  // Continuous watch — keeps running when screen locked on Android Chrome
  if (_locationWatcher) navigator.geolocation.clearWatch(_locationWatcher);
  _locationWatcher = navigator.geolocation.watchPosition(
    pos => {
      _userLat = pos.coords.latitude;
      _userLng = pos.coords.longitude;
      _gpsGranted = true;
      saveUserLocation(pos);
    },
    () => {},
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );

  // 5-minute forced ping — ensures location saves even when watchPosition
  // is throttled by the OS (app backgrounded, screen locked)
  if (_locationInterval) clearInterval(_locationInterval);
  _locationInterval = setInterval(_captureAndSaveLocation, 5 * 60 * 1000);

  // Register Periodic Background Sync (PWA installed on Android Chrome)
  _registerPeriodicLocationSync();

  // Persistent keepalive notification (prevents Android killing browser)
  _requestNotificationPermission();

  // Show green tracking dot in sidebar
  _showTrackingIndicator(true);
}

function stopLocationTracking() {
  if (_locationWatcher) { navigator.geolocation.clearWatch(_locationWatcher); _locationWatcher = null; }
  if (_locationInterval) { clearInterval(_locationInterval); _locationInterval = null; }
  _showTrackingIndicator(false);
  _dismissTrackingNotification();
}

// ── Register Periodic Background Sync ────────────────────────
async function _registerPeriodicLocationSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return;
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => ({ state: 'denied' }));
    if (perm.state !== 'granted') return;
    await reg.periodicSync.register('stfm-location-sync', { minInterval: 5 * 60 * 1000 });
    console.log('[LocationTracking] Periodic background sync registered');
  } catch(e) { console.warn('[LocationTracking] Periodic sync unavailable:', e.message); }
}

// ── Notification permission + persistent keepalive ───────────
async function _requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    setTimeout(async () => {
      const result = await Notification.requestPermission().catch(() => 'denied');
      if (result === 'granted') _showTrackingNotification();
    }, 3000);
  } else if (Notification.permission === 'granted') {
    _showTrackingNotification();
  }
}

async function _showTrackingNotification() {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('STFM — Location Tracking Active', {
      body: 'Your location is being tracked for your shift. Do not close this notification.',
      icon: "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCADiAN8DASIAAhEBAxEB/8QAHQABAAICAwEBAAAAAAAAAAAAAAcIBQYDBAkCAf/EAFkQAAEDAwEEBAYIDw0HBQAAAAEAAgMEBREGBxIhMRNBUWEIFCJxgZEyUnKCkqGx0hUXI0JDU1VWYpOVorLB0RgkJTU2N0Vjc3WUs8IWMzRUg4SjJ3TD4vH/xAAbAQEAAgMBAQAAAAAAAAAAAAAABAUCAwYBB//EAD8RAAEDAgMDCAgEBQQDAAAAAAEAAgMEEQUhMRJBUQYTYXGBkaHRFCIyUrHB4fAVIzNTNEJikvEkcrLSRIKi/9oADAMBAAIRAxEAPwC5aIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiL5mkjhifNK9scbGlz3uOA0DiST1BV22r7bKysnmtGjZnUtI0lklwAxLL/Z+1b+FzPVjr1TTNiF3KvxDEoKCPblPUN5U06t1vpbSrcXu7wQTYyKduZJT2eQ3Jx3ngouvnhD0MbnMsmnaioHISVcwi9O60Oz6wq+SySSyvlle6SR7i573nLnE8ySeZXyqySukd7OS4ar5WVkptCAwd58fJS1WbftaSvPi9FZadnUBBI4+svx8S46fb3riN4MtPZpm54h1M8fGHhRSi0ekS+8qv8bxC9+dKsfo7b7aK6dlLqS2vtbnHAqYnmWH3wxvNHwlMtNPDVU8dRTTRzQytD45I3BzXtPEEEcCFTXZtoa7a3vPilCDDSREGqq3NyyFvZ+E49TfkHFWzsNssmitKxUEEzKO2UTCXS1M2AMnLnuceAyST1DjwwrKklkeCX6cV2/J6vraqMvqR6g0doT8rdPxWbRRxdNtmz+hmdEy5VFY5pwTTUzi30F2AfRlcdNtw0BLL0c9ZXUh/rqN/wDpyt/pEXvBW5xWiBtzre8KS0WDsGsNL34hlov1BVyHlEyYCT4Bw74lnFtDg4XCmMkZINphuOhERF6s0RERERERERERERERERERERERERYyquodcTa7e0VFY0B0x+x0zTyLz2nqYOJ7h5Q4NVXmn0tpWvvdbI6VtJCXneODI/k1o6hlxA9K8LgBdanTMa0uJyGpUMeExryR1QdFWuYtjYGvuT2H2RPFsXmAw49uQOohQQue41lTcLhUV9ZIZampldLK8/XOcck+srgVBNKZXlxXyLE699dUOldpu6BuRERalXotx2W6Aueubv0UO9TW2Bw8brC3gzr3G9ryOrq5nqz2Nk+zm5a4uIeS+ks8L8VNXu8T+BHngXfE3mc8AbE6l1BpTZXpSCmZCyGNjSyjoYf95M4cz28+Lnnt6yQDLp6cOG2/Jq6TB8GEzfSqo7MQ47/p8dAu7LLpTZpo1gc6O322mGGN5yTyEZwOt7zj/wDAOFY9qO0O764uOZy6ltcLs01E13kt/Cf7Z/fyHIdecZrvV151lenXK7TZDctgp2E9HA09TR6snmfQMa872J8y8qKkyDZbk1eYxjrqv8iAbMQ8fp0K2mw3RFt07o+guEtHE+710Laied7AXsDxlsbfagAgHHM5Pm3q5Wy3XOAwXGgpayJwwWTwtkafQQvmwPZJYrfJHjcdSxluOwtGF3VcRsa1gaF9FpaaKGBsTBkAow1TsP0Zdw6S3xT2aoPEOpnb0ee9jsjHc0tWm1tBti2bAz0FwdqKzxDJDgZw1o9swnpGD3BIA5lWBRanUzDm3I9ChT4NTuO3DeN3FuXeNCok0Nt005eCymv0RslU7gJHO36d3v8AGW++GO9SxBNDUQsnglZLFIA5j2ODmuB6wRzCjbahshsuqo5a+1titd5PldKxuIpz2SNHWfbDj255KCrPqHW+y7UEtt35aYxPzNQVHlwSjPsgOw+2aQT29S0meSE2lFxxVc/FKvDHBla3aYdHj5j77VcFFpmzLaJZdcUP72PilyibmeikcC5v4TT9c3v9YC3NTGvDxdq6KCeOojEkRuCiIiyW5ERERERERERERFpetdS1zrzBo3Szo3X2qZvz1Dm7zLdB1zOHW7j5LTzJGeGM821fWlPonSstxcGSVsxMVFC76+QjmfwWjifQOZC6OxfS9RY9PPu14c+a/wB5cKqvml9mM8Wx92AeI7SeoBaXvLnbDe1V085lm9FjOerjwHDrPgM+C2zT1no7HbI6CiD3NBL5JZXb0k0h9lI9x4ucTxJUF+FNqzpqyl0fRy+RBiprt083kfU2HzAlxHe09SmzWeoKPS+ma2+VpzHTR5azODI88GsHeSQFSq83Gru92qrpXydJVVUrpZXdW8TnA7AOQHUAFGrZQxnNjf8ABUXKiubTU4pY8i7wH1811ERFUr52i3bY7ohuuNUOoqipNPQ0sfT1Jb7N7cgBrewnPPqC0lZXTGor3pm4OuFiuElFUujMbnta1wc04OC1wIPEDqWbC0OBdopVG+GOdrp23aDmFZzaDrnTuzGwQWW1UsD69sW7R0EfBsTep8h5gZ4+2cc95FX9R3u56ivE12u9U+pq5jxceAaOprR1NHUAurX1dVX1s1bW1ElRUzvL5ZZHZc9x6yVwLZPO6U8BwU7FcYlr3bI9Vg0b5/eSIiz2z/T8uqNY22yMYXMqJh05H1sTeMhz1eSDjvwFpALjYKriidK8MbqTZW/2fxTQaE0/BU56aO2U7ZM894RNys2vxjWsYGMAa1owAOQC/V0YFhZfa42bDA3gEREXqzRaptL0LadcWY0la0Q1kQJpKtrcvhcervaetvyEAja0WLmhwsVqmhjnjMcguCqR3a33/Q+qzTTmW33ShkD4pYncx1PYetpH6wRzCszsZ2k02trcaOs6OnvlMzM8I4Nmby6Rg7O0dRPYQuxtm0FDrbTp8XayO70gL6OU8N7tjcfau+I4PbmqVrrrnp6+w11G+SjuNDNkZGCx4JDmuHrBHnCqztUknFpXBuM3J2rsM4nffePFXoRa3s31bR6z0tT3imAjlP1OqgByYZRzb5uIIPWCFsitWuDhcLvYpWTMEjDcHMIiIvVsRERERCcc0WibdtRnTmzmulhk3Kut/edOc4ILwd4jvDA4+cBYveGNLjuWmpnbTxOldo0XUZUVUdq+3aKQ/VbBZsyRN5tdHG4YPYekk3T7kY6lYhQ54KtjbR6Qrr49mJbjU7jD/VRZA/PL/UFtu22+3nT+gKyssdJNLUPxG6oj4+KsPspSOfDkD1EgngFGgOxEZHanNUuFOMFE6smzc+7j1bh3KF/CQ1sL9qFunbfLvW+1yHpXNORLUYwT5mDLfOXdyiVCSTkkk9pRVEkhkcXFfOK6sfWTumfqfDgEREWCiIiIiIiIiIrO+DloSTT9lfqK6QGO53GMCKN48qCDmAewuOCR2Bo4HK1nYfsjmdPT6m1ZTGONhElJQSt8px5h8gPIdYaePb2GwKs6OmI9d3Yu95NYG6IiqnFj/KPmfkiIisl2qIiIiIiIiKuPhPaNbb7tDq2hixT1zuirGtHBswHkv98Ac97e1yscsLrmwQan0ncbHPgCqhLY3EewkHFjvQ4ArTURc6wtVZi9AK6ldFv1HX95KsewbWDtLa1hgqZi22XItp6kE+S1xPkSegnB7nHsVtlQqpglp55aaojMc0TzHIx3NrgcEHzFXC2L6kOp9ntvrZpOkq4G+K1Rzx6RmBk97m7rvfKHQS6xlc5ySryQ6kfuzHzH30rc0RFZLtkREREVbfCrvpqdT2+wxvzFQU5mlAP2STkD5mtB98rJKm2raj/ava7WFx3mV93bTMOecfSCJv5oChVzrMDRvXM8qZy2lbC3V5A7P82VqdnFr+gug7JbC0NfDRR9IAMeWRvP/OJWfc1rmlrgHNIwQRwIX6AAAAMAcgimNGyAF0UUYjYGDQCyhnaJsLtt0lkuGlJ4rXUu4upHg+LvP4OOMfoBHYAoR1JoXV2npHi6WGtjjb9njj6WIjt325A9OCrqIoktFG83GSoK7kxSVTttnqHo07vKyoMCDyIK/Vee4WGxXEl1wstuqyeZnpWPJ9YWJl2faGk9lpKzD3NGxvyBRjh7tzlRv5Gyg+rKO4/VUuX3BFJUTNggjfLK44axjS5x8wHFXPh2faGiOW6Ssp93Rsd8oKzlvt1ut8fR0FBS0jMY3YIWsHxBejD3b3LKPkbIT68o7BfyVT9KbI9b397HG2G10xwTNX5i4dzMb5Pox3qddnOyPTmkpIq6cG7XVnFtTOwBsZ7Y2cQ3znJ7CFIq4qqop6SnfU1U8UEMYy+SV4a1o7STwClRUkceepXQUHJ+jojt22nDefLRcqLVm7RtCOqOgGrLRvZxk1LQ34XL41stPPDUQMnp5Y5onjLHxuDmuHaCOakNc12hVxHPFL7Dgeo3XIiIsltREREREREREREVR/CCszbNtQuBiYGQ17W1rAB1vyH+t7Xn0rcPBOvJivF40/I87k8LauJp5BzDuv8ASQ5vwV2/C3t+H2C6tbzE1O849y5v+tR3sKrzb9q1jk3y1k0rqd49tvsc0D4RafQqc/lVXb8V83d/oMey0LvB3+VcFERXC+kIiIiLo6hrRbbBcbiSAKWllmyfwWF36lT/AGRU/je03TsT/KIro5DnrLPL/wBKtLtcm6HZjqN+cZt0rPhN3f1qs+wkB21vT4P22Q/+GRVtYbysH3quM5RO28QpozpceJHkrgoiKyXZrhrqqnoqOasqpWw08EbpZZHHgxrRkk+YBVR2o+EdepLlNR6acbdSsOG7rGmZ47XucCG554aMjtKsDtve+PZTqAscWk0waSOwvaCPUSvPW5EuuNUXHJMz/wBIqVQ0raqYsecgL5b1XysdU1PMFxDQ25sbE3NgL62y3Ld6ra7rmolMj7/dsnq+iM2B6A4BcX01tbfd+6/lGf560eNjpJGxsaXOcQGgdZKkjTWxjWd/tMdyt9sqpqeQkNka1oaSOBwXOG9x4ZHDIKsamlw2mtzjdesnwutdTSYbTENkabncNonryue1Y/6a2tvu/dfyjP8APT6a2tvu/dfyjP8APWwO8H/aEP6Gq/gxn/5F8O2B7QR/Q1Z+KYfkkUbawj3fB3ko+zhXuO/tk8lhqXajriepigbf7rmR4aP4Rn6z7pZ653u9XOFsNzvFxromu3msqap8rQ7tAcSM96/bdsO2gUddFUmxVsojdnd6Fozwxz3yupWU09HWTUdVE6GogkdFLG4YLHtOCD3ghUOMOpi9ophZts8iM+1clykdE17BTAhls7hwueHrLiWQt19vltpzT229XKihLi7o6erkjbk8zhpAyseipwbLmWPcw3abKTab6NVFNFUR6z1PuSsD2/wjJyIz2rk6G+ffnqb8oyftXHpsk2GjJ+1ALILjJsSq2SOaJDkSvokFLDJG1xGoG8+a6fQ3z789TflGT9qdDfPvz1N+UZP2ruItf4rWfuFbfQYeHifNdPob59+epvyjJ+1Ohvn356m/KMn7V3EwexPxWs/cKehQcPE+ayOymrvMG1m0UFRqK819PNBO58dVWPkaSI3Y4E4VilXPZsD9Oqxf+1qP8tysYvoWAyvlomvebkqfg7Q1kjRoHfIKI/Cqp+l2e0c4HGC5RknuMcg+UhV30jUeJ6ts1XnHQXCnlz7mRp/UrL+EyAdllQSOIq4CPhKq0bzHI2RvNpDh5wva3Ka647lP+XiTXjgD4q+yIOSK4X0hERERajtmaX7LdQgdVE4+ogqs+xKUQ7V9PPPI1Lm/Cjc39atVtAo3XHQt9oWDL57dOxnujGcfHhU70RWC36ysle526yC4QSOJ6miRufiyqysylY771XEcpTzeIU8p0y8CrwIiKzXbrStuf81F/wD7Bv8AmNXnvcf4wqf7V/yleiO2Gjlr9mOoKeBpdJ4m6QADJO5h5HqavPC7RuiulUx3PpXEeYnI+Iqzwcj0h46B8SocRtiDulg8HHzC59Nbn0bp9/tdu+fdOF6Q6TNAdL2v6FFhofE4vF9zlubox8S8z2Ocx7XscWuacgjmCt90ztb1jp+gbRW66VcMIJIZHPhgJ5kNIIGevGFuxOimklEsQvla1+k8etKmKaOp5+Nm2CACLgEWJO+wsb557l6DcEVEmbfdoLf6ZrfTIw/Kxc7PCE2gtGPozU+lkJ+WNVvoVX+0e9vmsfSagf8Aju72f9leZQjt12T1l6uEup9MRCWskA8co94NMpAxvsJ4b2AMjrxkceBgxvhE7Qm/01Uf4enPyxrmZ4R2v2kF13ld3GkpvmLVLh9RI3ZdEfDzUKuYa6IxTU77f+uXT7SxFdS1VBVOpa6mmpahnsopoyx7fODxC+aKNtTWwUweAZZGs59pA/WtxsvhJ3t00bb5RW65RNPEVVIGn0OYcDzlpVh9me0LS+0K3mno4Y4amNgfJQzBrhu59kw8ntz1jiOGQMjNW/DXxu2ZLt6x872XLR8m4zKGPkLSdA5tr9RvY9hWIi2FaNjAaKy+YHV420D4mqMr9p6i0xtMu1ntz53U0dNC9nTP33+U1pOTjtyrQKu+04Y2zXjvoqf9EKBj8EbKF5a0ArpK6hp6fmnRMAO1u6isYujPborvqfT1pqJJo4KyuEMpifuu3TjODgrvLjt/84Gkf71j/SC4fCADWxg8VqrWh0VjoS34hSb9IvSH/P34/wDeN+YvsbDtG/8AM3s/95/9VJ6L6j6JB7g7lajCqP8AbHctG0nss0vpq/QXu3m4PrIGuax09RvjDmlp4Y7CVvKItrI2sFmiwUqGnigbsxNAHQot8J+bo9mO59ur4WeoOd/pVX6GE1FdBTgZMsrWAecgKxHhaVjWaXstv3gHzVzpgO0MjLT/AJgUIbOaJ1x1/YKNrd4PuMBcPwWvDnfmgqqrPWnt1L55yj/OxQRj+kd/+VdkIiK4X0lERERfjgHNLXDIIwQqMamtrrRqG5WlwLfFKqWAZ7GuIB9QBV6FVbwlrIbZtHfXsYRBdIGTg9W+0bjx+a0++UDEGXYHcFyXK+nL6Zko/lPgfrZWR0Td237SNpvAIJq6SOR/c/HlD0OyPQswob8Fe/trNK1mnpXjprdMZIm/1UhJ+J+/8IKZFKhftxhyv8NqhVUrJeIz69/ivx7WvaWPaHNIwQRkEKpe3PYLdKW4z3bTNLLV29xLmshbvywDnuOYOLmjqcMkDnyybTagu9BYbPU3e6TGGjpmh0sgY55aCQOTQSeJHILTBto2cEfx/IPPQVHzFkZhE8ODtlw0++C11z6cOaXyhjxmDcA9x1B3hUSqNO3eCZ0LqYFzCQ4CQDB7CHYI9S4foLdf+Td6HtP61fAbUtl1xqo4n3SCeWVzWNMtum4knAGXR8Oa3GXTmnpR9VsNrk91SRn9SsGYxUnQtPYfNeQVVTMDzU0b7cAfk5ebhtFzHOil9GCvl1suI50NR6IyV6NTaJ0bNxl0nYnntNviz+iuu/Z5oV/PSVmHuaRg+QLYMXqvdb4rdzmIf0f/AF5ledLqGuHOhqh/0XfsXDIx8bt2RjmO54cMFeikmzHQMg8rS1vHuWlvyFRL4QuxrTtPpOe/2GmNH4qWmenDy9u64hu+zeyWkEjIzgjPpzbjUjTeRgtvsc/gvH1lXA0ySsaWjWxN7cbEZ261UNbtsb1NV6Z1nQ10Er2sglEpaDzaDh7fM5hcCtMlY6KV8b/ZMcWnzgrI6W/jhnuH/IrLE2tfRyHgLjszC2YuGuoZHjcNodYzBXpg0gtBByCMhV32qFzdtlxbnyXW2Fx9G6P2qwtN/wAPH7gfIq+7WR/611ffaYv0gvn3KD+AeoWKn8uI/wBQ+BWKXFQfy/0h/e0f6QXKuKg/l9pH+9Yv0guBwf8Ajo+tQav9Ptb/AMgrQBECL6yulREXXudbT263VNwq5BHT00TpZXn61rRkn1BF4SALlVn8KK8iv1/Da435jtlK1jh2SSeW783o11/BltJuG0tlc5hMdtpZJ89W+4dG0ep7j71R/qS6z3zUFfeKnIlrKh8xaTndDjkN9AwPQrGeC9p823RM97mj3Z7rPlhI49DHlrfzt8+YhU0P51Rtdq+b4cDiWMmbcCXdg0+SlxERXK+koiIiIos8JbTZvGg/orBHvVNok6fgOJhdgSD0eS7zMUprjqYYqmnkp542yRSsLHscODmkYIPoWErBIwtO9Ra2lbVQPhdo4Km+yTVH+yOuaK6SOIo3k09Z/YvIyfekNd71XLa5rmhzXBzSMgg8CFSraPpmbSOsK6ySBxijd0lM8/ZIXZ3D+o94Knnwb9cC9WAaZuE2bjbY/qBceM1OOA9LODT3bveq6ikLHGJy5DkzWuppn0E2Rvl17x27ltG3P+ai/wD9g3/MavPm4Syi4VOJZB9Vfyee0r0k1pZW6i0nc7IXiM1lO6NjyMhjseST5jgrz015pq56fv8AW01dSSQvjlIlYRxjdzOe48weRBGF0WFyMZUkP/mGXWCup2mR14Mmjm2F+IJNuuxWLs9xkorhFO+WUxg4eN4ngev0c1dfRO3bSNbpuklvlZLS3ARhs25TvkZI4Di9pYDwPPBwRy71RlfrXFud1xbnsOFZ1uGekPEjHbJ00uD8FInoXmXnqdwa61jcXBG7eMxcr0A+nVs6+7M/+Bm+an06tnX3Zn/wM3zVQDpH/bHfCTpH/bHfCUP8Fm/cH9v1Wv0av/cb/Yf+6v8A/Tq2dfdmf/AzfNUZbfttlgrtKTWGwOmnbVbvTzvjMeWghwYxp8okkDJIAA7c8Km9I/7Y74S/CSTkkk9pK9bgb3G0klxvsLfMrB9BVzNMc0o2TrZpBI4XLja/Uv2V7pJXyPOXPcXHzlZTSTHyXpjWNLjuO4Dnyx8pCxcbHySCONjnvPJrRkn0KfPBc2ZVt31HFfbjTltvopWySOI4Pe05bED1nOC7qAAHWFMxadkdM6Le4WA++CyxZ7fRzTN9p42QOvU9QGauJAC2CNpGCGgH1Kvu1zhtrqOHO0R/pqwqr3tgGNtUnfZoz/5CuDx/+Aeo2LC0cf8AuHzWIXFb/wCX2kf71i/SC5VxUP8AL7SP97RfpNXAYP8Ax0fWoFZ+l2t/5BWgREX1ldKihrwoNWC3adg0tSSfvq5YkqMHiyBp5e+cMeZrgpU1JeaDT1jqrxc5uipKVm+89Z6g0DrJOAB2lUv1lqCt1RqWtvlecS1L8tYDkRMHBrB3AADv4nrUKtm2GbI1K5nlNiQpqfmGn1n+A39+i/dGWCq1PqehsdHkPqpQ1zwP92wcXv8AQ0E/ErsWuiprbbaa30cYipqaJsUTB9a1owB6goq8G/QzrFY3aluUJbcblGBCxw4wwZyPS/g49wb15Uur2ih2GbR1Ky5M4aaSm5x49Z+fUN3miIimLpERERERERFGm3/QztV6ZFwt8W/d7a1z4mtHGaPm+PvPDI7xj64qsOnrvXWK9Ul4tk3RVdLIJI3dR6iCOsEEgjsJV6VWzwiNnTrRXS6ss0A+htS/NZEwf8PKT7PHtXH1E94xXVsB/UauM5TYU64rYPaGtujQ9inPZ/qu36x03BeKBwaT5FRCTl0MoHlMPyg9YIK+NZ6I0zq6NovdtZLMwbsdQwlkrB2Bw4kdxyO5VW2Xa3rtD6iFfAHTUU2GVtMDjpWDkR+E3JIPnHIlW909ebdf7PT3a1VLKikqG7zHt+MEdRB4EHkVup5mzts7VWeEYnDitPzcwBcNQd/T96FRDVeDZoyWYvZcLgAep8cLz69wLi/c0aP+6NZ+Ih+apyRSNgdPeVYfhdL7vifNQb+5o0f90az8RD81P3NGj/ujWfiIfmqckTYHE9580/C6X3fE+ag39zRo/wC6NZ+Ih+an7mjR/wB0az8RD81TkibA4nvPmn4XS+74nzUUad2B6EtUwlmZXXDBB6OaRrI/VG1pPmJKlCgo6WgpIqOhpoaamibuxxRMDWMHYAOAXOi9axrcwFvgpIKe/NtAv39+qKPte7Lbfq3Ugvkt6udBUCnbT4pi0DdaSeZGev4lIKLySNkjdl4uFlUU0VQ3YlFwoh+kXQffhqL8a39i7Vl2LW223233Y6kvNXJQ1DKiOOdzXNLmkHHLu6lKiKO2hp2m4YLqIMIowQQzxPmi+JpY4YXzTSMjjjaXPe84a0DiST1BcdwrKS30U1bXVMVNTQtL5JZXBrWDtJKrJto2rzaqc+y2F0tPZAfqjyC19WR2jmGdjeZ5nsGyedsLbnVeYnisOHx7TzcnQbz9OldTbntFdrG7C22yRwsdG8mPq8Yk4jpD3YyGjsJPXw7uwPZsdTV7dQXmD+BaWT6nG8cKuQHl3sB59RPDtx09jmyyt1fUx3S6skpbCx2S72L6rB9izsb2u9A45ItNQ0tNQ0cNHRwR09PAwMiijbhrGgYAAUOCF0zudk+/ouZwnDJsRn9OrNNw48OweK5hwREVmu5RERERERERERERcVZTU9ZSy0lVDHPBMwskjkblr2kYII6wuVEXhAIsVU/bRs0qdGV7rhbmST2Gd/1N/Emmcfsbz2djuvkePPF7LNoNz0Ndd6LeqbXO4Gqoy7g7q32djwPXjB6iLe19JS19FNRVtPHUU0zCyWKRoc17TzBBVadrmx2u08+W76bjmrrRkufAAXzUo+V7B28wOfWVVz0zonc5GuExXBZqCX0yh0Gdhu8x96KxGltQWnU1ojulmq2VNM/gccHMd1tcObXDsKyqpFo3VV70ldRcbJWGF5AEkbvKimb2Pb1jn3jPAhWV2cbX9O6pbFR1r22i6nh0Ez/qcp/q38j7k4Pn5qRBVtkydkVc4TyigrAGS+q/wPV5fFSQiIpi6NEREREREREWPvF8s1miMt2u1DQMHXUTtjz6zxUf3/bdpKkkdTWSOtv9XxAZSxFrM97nDOO9octb5WM9oqLUVtPT/qvA+PdqpQWl7QNpemdHMfFWVXjdxA8mipyHSZ6t7qYPPx7AVFt3vu2nXG9BabFWWOgecYjaadxb2mWQtcfeY8y+9K+D7VyvbUapvTIgTl0FEN97vPI4YB96fOo7qiR+UTe0qmmxWrqPUoYT/ucLDsvr95KP9ba31VtFu0dG5kxhc/FLbKQOc3PUSBxe7vPLjgBSRst2HFr4rrrZrXYw6O2sdkf9Vw5+5HDtJ4hS7pHR+nNKU5hsVrhpXOGHzcXSye6eckjuzgdQWabNE+Z0LHhz2ezA47vn7D3LyOkz25TcrXR8nhznpFc7nH+H1+HQvqGOOGJkMMbI42NDWMaMBoHIAdQX0vxwy0jJGRzHUoomfe7dT7QJhqu91BsFI8UYmfEQS6jEu87EYyQ53DGBwGQVJe/Y3K+qKgQW9W4N+G4E/AKWEUMaY1bqat1hpm01NwmLaGeSgu2Y2gVUxZUuY48PaQMfw+2KZ0jkEguFjSVjKppcwEWyz6vsdaIiLYpaIiIiIiIiIiIiIiIii3aRsYsWpXyXC0ObZrm7LnGNmYJnfhMHIn2ze3JBVfdZ6G1NpKVzb1bJGU+cNqovLgf2eWOXmdg9yuovmRjJY3RyMa9jhhzXDII7CFEmo2SZjIrnsR5N0tYS9nqO4jTtH+FUHRe1TWGl2sp6ev8AHqJuAKaszI0Dsa7O83zA47lLenfCB09VNYy+Wqttsp9k+HE8Q788HejdK2PVOxzQ98L5WW91qqHfZKBwjHwCCz4sqN774PN2ic51kv8AR1TeplXE6Iju3m7wPqCjhlTD7OYVS2lxzDsonbbR2/HPuUwWfaNoa6hvimp7cHO9iyeXoXn3smCtngmhnjEkEscrDycxwIPpCqTcdju0KjJxYxVNH11PUxuB9BIPxLEN0Zr22TF8Om7/AE8g4F9PTSZ9bAshVyt9pi3N5RV0WU9Mey4+R+Kugh4qn9JPtbpSOgOuGgdRZVEeojCzNHc9ucnkwt1V/wBSjcPje1ZitB/lKks5TNdkYH911ZY2KxmYzGzW4yk5L/FWbx9OF3YIIYG7sMUcTexjQB8SrpRW3wgLi4NNVc6Zh5vmqYYgPQDvfEs9b9lO0a4EO1FtFrIWE+VHBVTzZHZxLQD6Cs2zud7LD8FKixSST9Kld22b8VM9xuVutsJmuNfS0cYGS+eZsY9ZK1k7Q7FV1DqTTkdbqSracFlth342n8KZ2ImjzuWH09sX0VbJhU11PU3qq5ukr5d8E+5GGn05UhUdLTUdMymo6eGngYMMjiYGNaO4DgFuHOO1sPFWDDVye2Awf3H5AeKwtLSaguZEt5qY7bTnj4lQSFzz/aTkA9nBgbg/XOCzlNBDTQthp4mRRt9i1gwAuRFsAspTIwzpPEoulLabXKyuZLb6V7bgN2sDogfGBu7mH+28kY49XBd1EIB1WZaHahY+OyWeOqFVHa6Nk4nFR0jYWh3ShnRh+cey3CW57OCyCIgAGi8a0N0CIiL1ZIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiL//2Q==",
      tag: 'stfm-tracking-active',
      renotify: false,
      silent: true,
      requireInteraction: true,
    });
  } catch(e) {}
}

async function _dismissTrackingNotification() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    (await reg.getNotifications({ tag: 'stfm-tracking-active' })).forEach(n => n.close());
    (await reg.getNotifications({ tag: 'stfm-location-paused' })).forEach(n => n.close());
  } catch(e) {}
}

// ── Sidebar tracking dot ──────────────────────────────────────
function _showTrackingIndicator(active) {
  let dot = document.getElementById('locationTrackingDot');
  if (!dot) {
    dot = document.createElement('span');
    dot.id = 'locationTrackingDot';
    dot.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--grn);font-weight:600;margin-left:6px;vertical-align:middle';
    const sbName = document.getElementById('sbName');
    if (sbName) sbName.insertAdjacentElement('afterend', dot);
  }
  dot.innerHTML = active ? '<span style="width:7px;height:7px;border-radius:50%;background:var(--grn);animation:pulse 2s infinite;display:inline-block"></span>' : '';
  dot.style.display = active ? '' : 'none';
}

let _lastSavedLat=null,_lastSavedLng=null,_lastSavedTs=0;
const _LOC_MIN_DIST=0.0002; // ~20m threshold — skip write if user barely moved
const _LOC_MIN_MS=30000;    // min 30s between writes (was 60s) for faster live tracking

async function saveUserLocation(pos) {
  if (!CU || !CU.uid) return;
  if (isAdmin()) return;  // admins never tracked
  const lat=pos.coords.latitude, lng=pos.coords.longitude;
  const now=Date.now();
  // Skip if location hasn't changed meaningfully and was written recently
  if(_lastSavedLat!==null && (now-_lastSavedTs)<_LOC_MIN_MS) {
    const dLat=Math.abs(lat-_lastSavedLat), dLng=Math.abs(lng-_lastSavedLng);
    if(dLat<_LOC_MIN_DIST && dLng<_LOC_MIN_DIST) return;
  }
  try {
    await window.__SF.updateDoc(rootDocRef('users', CU.uid), {
      lastLat: lat,
      lastLng: lng,
      lastLocationAt: new Date().toISOString(),
      lastAccuracy: Math.round(pos.coords.accuracy),
    });
    _lastSavedLat=lat; _lastSavedLng=lng; _lastSavedTs=now;
    navigator.serviceWorker?.controller?.postMessage({
      type: 'LOCATION_UPDATE', lat, lng,
    });
  } catch(e) { /* silent */ }
}

// ── Live Rep Locations — real-time onSnapshot listener ─────────────────
let _repLocUnsub = null;          // active Firestore listener
let _repLocAgeTimer = null;       // interval that ticks the "X min ago" labels
let _repLocLastData = [];         // cached field user data for age-ticker re-renders

function openRepLocations() {
  if(!isAdmin()) { showToast('Admin only','error'); return; }
  closeSidebar(); // ensure sidebar and its backdrop don't block the modal close button
  _startRepLocationsListener();
  openM('mRepLocations');
}

function closeRepLocations() {
  _stopRepLocationsListener();
  closeM('mRepLocations');
}

function _startRepLocationsListener() {
  _stopRepLocationsListener(); // clean up any existing listener

  const list = document.getElementById('repLocationsList');
  if(!list) return;
  list.innerHTML='<div style="font-size:13px;color:var(--tx3);padding:14px 0">Connecting to live feed…</div>';

  // Update the modal header to show LIVE badge
  const ttl = document.querySelector('#mRepLocations .mttl');
  if(ttl) ttl.innerHTML='📍 Sales Rep Locations <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;color:var(--grn);background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.25);border-radius:6px;padding:2px 7px;margin-left:6px;vertical-align:middle"><span style="width:6px;height:6px;border-radius:50%;background:var(--grn);animation:pulse 2s infinite;display:inline-block"></span>LIVE</span>';

  try {
    const { onSnapshot, query, collection } = window.__SF;
    const usersRef = rootCol('users');
    _repLocUnsub = onSnapshot(usersRef, snap => {
      let fieldUsers = snap.docs.map(d=>d.data())
        .filter(u=>['sales_rep','delivery_man'].includes(u.role) && u.status==='active');
      if(isOwner() && _ownerZoneFilter) {
        fieldUsers = fieldUsers.filter(u=>u.zoneId===_ownerZoneFilter);
      } else if(!isOwner() && CU.zoneId) {
        fieldUsers = fieldUsers.filter(u=>u.zoneId===CU.zoneId);
      }
      _repLocLastData = fieldUsers;
      _renderRepLocationsList(fieldUsers);
      _updateRepLocationsBadge(fieldUsers);
    }, err => {
      if(list) list.innerHTML=`<div style="color:var(--red);font-size:13px;padding:14px">Live feed error: ${err.message}</div>`;
      console.error('[repLocations live]', err);
    });
  } catch(e) {
    // Fallback: onSnapshot not available, do a one-time read
    console.warn('[repLocations] onSnapshot unavailable, falling back to one-time read');
    refreshRepLocations();
    return;
  }

  // Age ticker — re-renders time labels every 30s without hitting Firestore
  _repLocAgeTimer = setInterval(() => {
    if(_repLocLastData.length) _renderRepLocationsList(_repLocLastData);
  }, 30000);
}

function _stopRepLocationsListener() {
  if(_repLocUnsub) { _repLocUnsub(); _repLocUnsub = null; }
  if(_repLocAgeTimer) { clearInterval(_repLocAgeTimer); _repLocAgeTimer = null; }
  _repLocLastData = [];
  // Reset header
  const ttl = document.querySelector('#mRepLocations .mttl');
  if(ttl) ttl.textContent = '📍 Sales Rep Locations';
}

function _renderRepLocationsList(fieldUsers) {
  const list = document.getElementById('repLocationsList');
  if(!list) return;

  if(!fieldUsers.length) {
    list.innerHTML='<div style="color:var(--tx3);font-size:13px;padding:20px;text-align:center">No field users found in this zone</div>';
    return;
  }

  const now = Date.now();
  // Sort: recently updated first
  const sorted = [...fieldUsers].sort((a,b)=>{
    const aT = a.lastLocationAt ? new Date(a.lastLocationAt).getTime() : 0;
    const bT = b.lastLocationAt ? new Date(b.lastLocationAt).getTime() : 0;
    return bT - aT;
  });

  // "Open All on Map" button — builds a multi-stop Google Maps URL
  const withLoc = sorted.filter(u=>u.lastLat&&u.lastLng);
  const allMapBtn = withLoc.length >= 2
    ? `<a href="https://maps.google.com/maps?q=${withLoc.map(u=>`${u.lastLat},${u.lastLng}`).join('+')}+to+" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;background:var(--acc);color:#fff;border-radius:var(--r2);font-size:11px;font-weight:700;text-decoration:none;margin-bottom:12px">🗺️ Open All on Map</a>`
    : '';

  const activeCount = withLoc.filter(u => u.lastLocationAt && (now - new Date(u.lastLocationAt).getTime()) < 15*60*1000).length;
  const summaryBar = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:6px">
    <div style="font-size:12px;color:var(--tx2)">
      <span style="color:var(--grn);font-weight:700">${activeCount}</span> active now ·
      <span style="font-weight:700">${fieldUsers.length}</span> total reps
    </div>
    ${allMapBtn}
  </div>`;

  list.innerHTML = summaryBar + sorted.map(u => {
    const hasLoc = u.lastLat && u.lastLng;
    const locAge = hasLoc && u.lastLocationAt ? Math.round((now - new Date(u.lastLocationAt).getTime())/60000) : null;
    const fresh = locAge !== null && locAge < 15;
    const warn  = locAge !== null && locAge < 60;
    const dotColor = fresh ? 'var(--grn)' : warn ? 'var(--ylw)' : 'var(--tx3)';
    const roleLabel = {sales_rep:'Sales Rep',delivery_man:'Delivery Man'}[u.role]||u.role;
    const roleBg = {sales_rep:'var(--blu)',delivery_man:'var(--grn)'}[u.role]||'var(--tx3)';
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${u.lastLat},${u.lastLng}&travelmode=driving`;
    const gmapsView = `https://maps.google.com/?q=${u.lastLat},${u.lastLng}`;
    const zoneName_ = u.zoneName || u.zoneId || '—';
    const ageLabel = locAge===null ? '' : locAge===0 ? 'Just now' : locAge<60 ? `${locAge}m ago` : `${Math.round(locAge/60)}h ago`;
    const locTimeStr = u.lastLocationAt ? new Date(u.lastLocationAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}) : '';
    return `
    <div style="background:var(--s2);border:1px solid ${fresh?'rgba(34,197,94,.3)':'var(--bdr)'};border-radius:var(--r);padding:14px;margin-bottom:10px;transition:border-color 0.3s">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:${hasLoc?'10px':'0'}">
        <div style="position:relative">
          <div class="ava" style="background:${roleBg};width:42px;height:42px;flex-shrink:0">${u.name[0].toUpperCase()}</div>
          <span style="position:absolute;bottom:0;right:0;width:10px;height:10px;border-radius:50%;background:${hasLoc?dotColor:'var(--tx3)'};border:2px solid var(--s2)${fresh?';animation:pulse 2s infinite':''}"></span>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px">${u.name}</div>
          <div style="font-size:11px;color:var(--tx3)">${roleLabel}${isOwner()?' · '+zoneName_:''}</div>
          ${!hasLoc?'<div style="font-size:11px;color:var(--tx3);margin-top:2px">📍 Location not shared yet</div>':''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          ${hasLoc&&locAge!==null?`
            <div style="font-size:11px;font-weight:700;color:${dotColor}">${ageLabel}</div>
            ${locTimeStr?`<div style="font-size:10px;color:var(--tx3)">${locTimeStr}</div>`:''}
          `:''}
        </div>
      </div>
      ${hasLoc?`
      <div style="background:var(--s1);border:1px solid var(--bdr);border-radius:var(--r2);padding:10px 12px">
        <div style="font-size:11px;color:var(--tx3);margin-bottom:7px">
          ${u.lastLat.toFixed(6)}, ${u.lastLng.toFixed(6)}
          ${u.lastAccuracy?`<span style="margin-left:6px">±${u.lastAccuracy}m</span>`:''}
        </div>
        <div style="display:flex;gap:7px">
          <a href="${gmapsView}" target="_blank" style="flex:1;text-align:center;padding:7px;background:var(--s2);border:1px solid var(--bdr);border-radius:var(--r2);font-size:11px;font-weight:600;color:var(--tx);text-decoration:none">🗺️ View</a>
          <a href="${mapsUrl}" target="_blank" style="flex:1;text-align:center;padding:7px;background:var(--acc);border-radius:var(--r2);font-size:11px;font-weight:700;color:#fff;text-decoration:none">🚗 Navigate</a>
        </div>
      </div>`:''}
    </div>`;
  }).join('');
}

// Update sidebar button badge with active rep count
function _updateRepLocationsBadge(fieldUsers) {
  const now = Date.now();
  const activeCount = fieldUsers.filter(u =>
    u.lastLat && u.lastLng && u.lastLocationAt &&
    (now - new Date(u.lastLocationAt).getTime()) < 15*60*1000
  ).length;
  let badge = document.getElementById('repLocBadge');
  if(!badge) {
    const btn = document.querySelector('button[onclick="openRepLocations()"]');
    if(btn) {
      badge = document.createElement('span');
      badge.id = 'repLocBadge';
      badge.style.cssText='display:inline-flex;align-items:center;justify-content:center;background:var(--grn);color:#fff;border-radius:50%;font-size:10px;font-weight:700;width:18px;height:18px;margin-left:auto;flex-shrink:0';
      btn.appendChild(badge);
    }
  }
  if(badge) {
    badge.textContent = activeCount;
    badge.style.display = activeCount > 0 ? 'inline-flex' : 'none';
  }
}

// Legacy one-shot fallback (kept for compatibility)
async function refreshRepLocations() {
  const list = document.getElementById('repLocationsList');
  if(!list) return;
  list.innerHTML='<div style="font-size:13px;color:var(--tx3);padding:14px 0">Refreshing…</div>';
  try {
    const uSnap = await window.__SF.getDocs(rootCol('users'));
    let fieldUsers = uSnap.docs.map(d=>d.data())
      .filter(u=>['sales_rep','delivery_man'].includes(u.role) && u.status==='active');
    if(isOwner() && _ownerZoneFilter) {
      fieldUsers = fieldUsers.filter(u=>u.zoneId===_ownerZoneFilter);
    } else if(!isOwner() && CU.zoneId) {
      fieldUsers = fieldUsers.filter(u=>u.zoneId===CU.zoneId);
    }
    _repLocLastData = fieldUsers;
    _renderRepLocationsList(fieldUsers);
    _updateRepLocationsBadge(fieldUsers);
  } catch(e) {
    if(list) list.innerHTML=`<div style="color:var(--red);font-size:13px;padding:14px">Error: ${e.message}</div>`;
  }
}

