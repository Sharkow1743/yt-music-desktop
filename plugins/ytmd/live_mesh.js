(function() {
    const initMesh = () => {
        const playerPage = document.querySelector('ytmusic-player-page');
        if (!playerPage || document.getElementById('live-mesh-bg')) return;

        const bg = document.createElement('div');
        bg.id = 'live-mesh-bg';
        playerPage.appendChild(bg);

        // INCREASED LIMIT: Total number of blobs
        const blobCount = 15; 

        for (let i = 0; i < blobCount; i++) {
            const blob = document.createElement('div');
            blob.className = 'mesh-blob';
            
            /**
             * DISTRIBUTION LOGIC: 
             * Math.pow(Math.random(), 2) biases results towards 0.
             * This makes small sizes very common and large sizes rare.
             */
            const minSize = 20;
            const maxSize = 100; // Increased limit to 100vw
            const sizeWeight = Math.pow(Math.random(), 3); // Cubed for even rarer high values
            const size = minSize + (sizeWeight * (maxSize - minSize));
            
            blob.style.width = `${size}vw`;
            blob.style.height = `${size}vw`;
            
            bg.appendChild(blob);
            moveBlob(blob, true); 
        }
    };

    function moveBlob(blob, isFirstRun = false) {
        // Position: Higher values for X/Y are equally likely (random placement)
        const x = (Math.random() * 160) - 30; 
        const y = (Math.random() * 160) - 30;
        
        // SCALE: Higher scale is rarer
        const scaleWeight = Math.pow(Math.random(), 2);
        const scale = 0.5 + (scaleWeight * 2.5); // Range 0.5 to 3.0, but mostly low
        
        // OPACITY: Higher opacity is rarer
        const opacityWeight = Math.pow(Math.random(), 2);
        const opacity = 0.1 + (opacityWeight * 0.4);
        
        /**
         * DURATION: Higher duration (slower movement) is rarer
         * Most blobs will move faster, few will be very slow.
         */
        const minDur = 10000;
        const maxDur = 60000; // Increased limit to 60 seconds
        const durWeight = Math.pow(Math.random(), 2);
        const duration = isFirstRun ? 0 : minDur + (durWeight * (maxDur - minDur));

        blob.style.transition = `all ${duration}ms ease-in-out`;
        blob.style.left = `${x}%`;
        blob.style.top = `${y}%`;
        blob.style.transform = `translate(-50%, -50%) scale(${scale})`;
        blob.style.opacity = opacity;

        setTimeout(() => moveBlob(blob), duration || 100);
    }

    const runUpdate = setInterval(() => {
        if (document.querySelector('ytmusic-player-page')) {
            initMesh();
            clearInterval(runUpdate);
        }
    }, 1000);
})();