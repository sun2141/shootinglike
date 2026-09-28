import cv2, numpy as np, sys
# zoom.py video frame out x0,y0,w,h[,..] scale
v,fi,out=sys.argv[1],int(sys.argv[2]),sys.argv[3]; sc=int(sys.argv[-1]); rects=sys.argv[4:-1]
cap=cv2.VideoCapture(v); cap.set(cv2.CAP_PROP_POS_FRAMES,fi); ok,f=cap.read()
tiles=[]
for r in rects:
    x,y,w,h=map(int,r.split(','))
    c=cv2.resize(f[y:y+h,x:x+w],None,fx=sc,fy=sc,interpolation=cv2.INTER_NEAREST)
    for gx in range(0,w+1,10):
        cv2.line(c,(gx*sc,0),(gx*sc,8),(0,0,255),1); cv2.putText(c,str(x+gx),(gx*sc+1,18),0,0.35,(0,0,255),1) if gx%20==0 else None
    for gy in range(0,h+1,10):
        cv2.line(c,(0,gy*sc),(8,gy*sc),(0,0,255),1); cv2.putText(c,str(y+gy),(10,gy*sc+4),0,0.35,(0,0,255),1) if gy%20==0 else None
    tiles.append(c)
H=max(t.shape[0] for t in tiles)
tiles=[cv2.copyMakeBorder(t,0,H-t.shape[0],0,4,cv2.BORDER_CONSTANT) for t in tiles]
cv2.imwrite(out,np.hstack(tiles))
