(function() {
    const initMesh = () => {
        const playerPage = document.querySelector('ytmusic-player-page');
        if (!playerPage || document.getElementById('live-mesh-bg')) return;

        const bg = document.createElement('div');
        bg.id = 'live-mesh-bg';
        playerPage.appendChild(bg);

        const blobCount = 8; // Increased count for better variety

        for (let i = 0; i < blobCount; i++) {
            const blob = document.createElement('div');
            blob.className = 'mesh-blob';
            
            // Randomize size for each blob once
            const size = 30 + Math.random() * 40; // Sizes range from 30vw to 70vw
            blob.style.width = `${size}vw`;
            blob.style.height = `${size}vw`;
            
            bg.appendChild(blob);
            
            // Initial random placement
            moveBlob(blob, true); 
        }
    };

    function moveBlob(blob, isFirstRun = false) {
        // Range from -20% to 120% to allow blobs to move off any edge
        const x = (Math.random() * 140) - 20;
        const y = (Math.random() * 140) - 20;
        
        const scale = 0.5 + Math.random() * 1.5;
        const opacity = blob.classList.contains('highlight') ? 0.05 : (0.2 + Math.random() * 0.4);
        
        // Random duration for organic movement
        const duration = isFirstRun ? 0 : (15000 + Math.random() * 25000);

        blob.style.transition = `all ${duration}ms ease-in-out`;
        
        // We use left/top for position and translate for centering/scaling
        blob.style.left = `${x}%`;
        blob.style.top = `${y}%`;
        blob.style.transform = `translate(-50%, -50%) scale(${scale})`;
        blob.style.opacity = opacity;

        // Queue next movement
        setTimeout(() => moveBlob(blob), duration || 100);
    }

    // Initialize with a check for the player page
    const runUpdate = setInterval(() => {
        if (document.querySelector('ytmusic-player-page')) {
            initMesh();
            clearInterval(runUpdate);
        }
    }, 1000);
})();