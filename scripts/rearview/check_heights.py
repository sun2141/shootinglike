import pickle, numpy as np, sys
def ground(o,P,z=0.0):
    f,R,t=o['f'],o['R'],o['t']; cx,cy=o['size'][0]/2,o['size'][1]/2; C=-R.T@t
    d=R.T@np.array([(P[0]-cx)/f,(P[1]-cy)/f,1.0]); s=(z-C[2])/d[2]; return C+s*d
def proj(o,P):
    f,R,t=o['f'],o['R'],o['t']; cx,cy=o['size'][0]/2,o['size'][1]/2; Pc=R@P+t; return np.array([f*Pc[0]/Pc[2]+cx,f*Pc[1]/Pc[2]+cy])
items=[('08 kicker 172(+shoe,-posture=173)',(650,758),(657,438),1.73,0),('11 kicker 172 (173)',(672,748),(655,437.5),1.73,1.04),('09 kicker 182 cap (184.5)',(680,768.8),(684,423.75),1.845,-1.02)]
for pk in sys.argv[1:]:
    o=pickle.load(open(pk,'rb')); print(pk,'f',round(o['f']))
    for nm,b,tp,H,dy in items:
        b=(b[0],b[1]+dy); tp=(tp[0],tp[1]+dy)
        P=ground(o,b); pr=proj(o,P+np.array([0,0,H]))
        print(f"   {nm}: meas {b[1]-tp[1]:.1f} pred {b[1]-pr[1]:.1f} ratio {(b[1]-tp[1])/(b[1]-pr[1]):.3f} dist {np.linalg.norm(P-o['C']):.1f}m")
